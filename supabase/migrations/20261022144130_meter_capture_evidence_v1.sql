-- Internal, immutable meter evidence. No OCR output is a billable reading until a human confirms.
-- Storage verification and worker RPCs are service-role only; frontend JSON RPCs enforce exact org/building scope.
CREATE TABLE IF NOT EXISTS app_private.meter_capture_profiles (
  meter_id uuid PRIMARY KEY REFERENCES public.meters(id), organization_id uuid NOT NULL,
  qr_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), version integer NOT NULL DEFAULT 1,
  serial_number text NOT NULL, display_kind text NOT NULL CHECK(display_kind IN ('DIGITAL','MECHANICAL')),
  decimal_places integer NOT NULL CHECK(decimal_places BETWEEN 0 AND 2), register_code text NOT NULL,
  reference_path text, verified_by uuid NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_profile_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meter_id uuid NOT NULL, organization_id uuid NOT NULL,
  actor_id uuid NOT NULL, action text NOT NULL, reason text, before_state jsonb, after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.meter_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL,
  room_id uuid NOT NULL, meter_id uuid NOT NULL REFERENCES public.meters(id), contract_id uuid NOT NULL REFERENCES public.contracts(id),
  actor_id uuid NOT NULL, client_id uuid NOT NULL, request_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('MONTHLY','MOVE_OUT')), reading_date date NOT NULL, month text NOT NULL,
  captured_at timestamptz NOT NULL, received_at timestamptz, profile_snapshot jsonb NOT NULL,
  qr_text text, status text NOT NULL DEFAULT 'AWAITING_UPLOAD' CHECK(status IN ('AWAITING_UPLOAD','QUEUED','PROCESSING','REVIEW','CONFIRMED')),
  version integer NOT NULL DEFAULT 1, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=104857600),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), duration_seconds numeric,
  object_key text NOT NULL UNIQUE, media_received boolean NOT NULL DEFAULT false, media_validated boolean NOT NULL DEFAULT false,
  reading_id uuid UNIQUE, confirmed_value numeric, previous_value numeric, confirmed_by uuid, confirmed_at timestamptz,
  reason text, issues jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,actor_id,client_id),
  CHECK((mime_type LIKE 'video/%' AND duration_seconds>0 AND duration_seconds<=60) OR (mime_type LIKE 'image/%' AND duration_seconds IS NULL))
);
CREATE INDEX IF NOT EXISTS meter_captures_scope_idx ON app_private.meter_captures(organization_id,building_id,month,created_at DESC);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capture_id uuid NOT NULL REFERENCES app_private.meter_captures(id),generation integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0, worker_id text, lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(capture_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS meter_capture_jobs_one_active_idx ON app_private.meter_capture_jobs(capture_id) WHERE state IN ('QUEUED','RUNNING');
CREATE TABLE IF NOT EXISTS app_private.meter_capture_results (
  job_id uuid PRIMARY KEY REFERENCES app_private.meter_capture_jobs(id), capture_id uuid NOT NULL REFERENCES app_private.meter_captures(id),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  document_kind text NOT NULL CHECK(document_kind IN ('INVOICE','EXIT')), document_id uuid NOT NULL,
  contract_id uuid NOT NULL, meter_id uuid NOT NULL, source jsonb NOT NULL,
  start_reading_id uuid, end_reading_id uuid NOT NULL REFERENCES public.meter_readings(id),
  linked_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(document_kind,document_id,meter_id)
);
CREATE TABLE IF NOT EXISTS app_private.meter_capture_document_requests (
  organization_id uuid NOT NULL, actor_id uuid NOT NULL, request_key text NOT NULL,
  payload_hash text NOT NULL, result jsonb,
  PRIMARY KEY(organization_id,actor_id,request_key)
);
ALTER TABLE app_private.meter_capture_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_profile_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.meter_capture_document_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.meter_capture_profiles,app_private.meter_capture_profile_history,
 app_private.meter_captures,app_private.meter_capture_jobs,app_private.meter_capture_results,
 app_private.meter_capture_evidence_links,app_private.meter_capture_document_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.meter_capture_scope_v1(p_org uuid,p_building uuid,p_action text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_allowed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) OR NOT EXISTS(
    SELECT 1 FROM public.buildings WHERE id=p_building AND organization_id=p_org AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'Meter evidence scope denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,p_action,p_building,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Meter evidence permission denied' USING ERRCODE='42501'; END IF;
END $$;

-- Preserve the period selected by confirmation after legacy BEFORE INSERT autofill triggers.
CREATE OR REPLACE FUNCTION app_private.meter_capture_reading_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;
BEGIN
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
DROP TRIGGER IF EXISTS zzz_meter_capture_reading_guard ON public.meter_readings;
CREATE TRIGGER zzz_meter_capture_reading_guard BEFORE INSERT OR UPDATE OR DELETE ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_reading_guard_v1();

CREATE OR REPLACE FUNCTION app_private.meter_capture_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Meter evidence history is immutable' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION app_private.meter_capture_profile_move_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE p app_private.meter_capture_profiles%ROWTYPE;v_before jsonb;
BEGIN
 IF (NEW.room_id,NEW.building_id,NEW.organization_id,NEW.serial_number,NEW.status,NEW.deleted_at) IS DISTINCT FROM
    (OLD.room_id,OLD.building_id,OLD.organization_id,OLD.serial_number,OLD.status,OLD.deleted_at) THEN
  SELECT * INTO p FROM app_private.meter_capture_profiles WHERE meter_id=NEW.id FOR UPDATE;
  IF FOUND THEN
   v_before:=to_jsonb(p)||jsonb_build_object('roomId',OLD.room_id,'buildingId',OLD.building_id);
   UPDATE app_private.meter_capture_profiles SET revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE meter_id=NEW.id RETURNING * INTO p;
   INSERT INTO app_private.meter_capture_profile_history(meter_id,organization_id,actor_id,action,reason,before_state,after_state)
    VALUES(NEW.id,p.organization_id,COALESCE(auth.uid(),p.verified_by),'meterChanged','Vị trí, serial hoặc trạng thái đồng hồ đã đổi; cần đăng ký tem mới',v_before,to_jsonb(p)||jsonb_build_object('roomId',NEW.room_id,'buildingId',NEW.building_id));
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meter_capture_profile_move ON public.meters;
CREATE TRIGGER meter_capture_profile_move AFTER UPDATE ON public.meters FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_profile_move_v1();
DROP TRIGGER IF EXISTS meter_capture_results_immutable ON app_private.meter_capture_results;
CREATE TRIGGER meter_capture_results_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_results FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();
DROP TRIGGER IF EXISTS meter_capture_history_immutable ON app_private.meter_capture_profile_history;
CREATE TRIGGER meter_capture_history_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_profile_history FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();
DROP TRIGGER IF EXISTS meter_capture_links_immutable ON app_private.meter_capture_evidence_links;
CREATE TRIGGER meter_capture_links_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_evidence_links FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();

-- Adapt only allowlisted existing writers to their installed named argument signatures.
-- This retains the current credit/rent-support/default behavior without duplicating money writers.
CREATE OR REPLACE FUNCTION app_private.meter_capture_invoke_writer_v1(p_name text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE f record; i integer; v_parts text[]; v_sql text; v_result jsonb; v_count integer:=0; v_candidate text;
BEGIN
 IF p_name NOT IN ('create_invoice_v1','create_invoice_with_credit_v1','confirm_contract_return_v1','finalize_contract_exit_case_v1','finalize_contract_transfer_exit_v1') OR jsonb_typeof(p_args) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported meter document writer' USING ERRCODE='22023'; END IF;
 FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=p_name AND p.prokind='f' LOOP
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_args) k WHERE NOT k=ANY(f.proargnames)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM generate_series(1,f.pronargs-f.pronargdefaults) k WHERE NOT p_args ? f.proargnames[k]) THEN CONTINUE; END IF;
  v_parts:=ARRAY[]::text[];
  FOR i IN 1..f.pronargs LOOP
   IF p_args ? f.proargnames[i] THEN
    v_parts:=array_append(v_parts,format('%I => %s',f.proargnames[i],CASE WHEN f.proargtypes[i-1] IN ('json'::regtype,'jsonb'::regtype)
     THEN format('($1->%L)::%s',f.proargnames[i],format_type(f.proargtypes[i-1],NULL))
     ELSE format('($1->>%L)::%s',f.proargnames[i],format_type(f.proargtypes[i-1],NULL)) END));
   END IF;
  END LOOP;
  v_candidate:=format('SELECT to_jsonb(public.%I(%s))',p_name,array_to_string(v_parts,','));v_count:=v_count+1;
 END LOOP;
 IF v_count<>1 THEN RAISE EXCEPTION 'Meter document writer signature not found or ambiguous' USING ERRCODE='55000'; END IF;
 EXECUTE v_candidate INTO v_result USING p_args;RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_validate_sources_v1(p_org uuid,p_contract uuid,p_sources jsonb,p_purpose text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s jsonb;v_match jsonb;v_count integer;
BEGIN
 IF jsonb_typeof(p_sources) IS DISTINCT FROM 'array' OR jsonb_array_length(p_sources)=0 OR jsonb_array_length(p_sources)>100 THEN RAISE EXCEPTION 'Expected meter sources' USING ERRCODE='22023'; END IF;
 SELECT count(DISTINCT x->>'meterId') INTO v_count FROM jsonb_array_elements(p_sources) x;
 IF v_count<>jsonb_array_length(p_sources) THEN RAISE EXCEPTION 'Duplicate meter sources' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meter document contract not found' USING ERRCODE='42501'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
  IF s->>'contractId' IS DISTINCT FROM p_contract::text OR s->>'purpose' IS DISTINCT FROM p_purpose THEN RAISE EXCEPTION 'Meter source contract/purpose mismatch' USING ERRCODE='22023'; END IF;
  -- Locks prevent changing a source after validation and before writing its document.
  PERFORM 1 FROM public.meter_readings WHERE id IN ((s->>'startReadingId')::uuid,(s->>'endReadingId')::uuid) ORDER BY id FOR SHARE;
  SELECT x INTO v_match FROM jsonb_array_elements(app_private.meter_capture_resolve_billing_v1(p_org,s)->'meters') x WHERE x->>'meterId'=s->>'meterId';
  IF v_match IS NULL OR v_match->'start'='null'::jsonb OR v_match->'end'='null'::jsonb OR v_match->'issues'<>'[]'::jsonb OR
   v_match#>>'{start,readingId}' IS DISTINCT FROM s->>'startReadingId' OR v_match#>>'{end,readingId}' IS DISTINCT FROM s->>'endReadingId' OR
   v_match#>>'{start,version}' IS DISTINCT FROM s->>'startVersion' OR v_match#>>'{end,version}' IS DISTINCT FROM s->>'endVersion' OR
   (v_match#>>'{start,value}')::numeric IS DISTINCT FROM (s->>'previousReading')::numeric OR
   (v_match#>>'{end,value}')::numeric IS DISTINCT FROM (s->>'currentReading')::numeric THEN
   RAISE EXCEPTION 'Meter source changed or does not match billed values; reload' USING ERRCODE='PT409'; END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_attach_v1(p_org uuid,p_kind text,p_document uuid,p_contract uuid,p_sources jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s jsonb;v_snapshot jsonb;
BEGIN
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
  v_snapshot:=s||jsonb_build_object('startCaptureId',(SELECT id FROM app_private.meter_captures WHERE reading_id=(s->>'startReadingId')::uuid),
    'endCaptureId',(SELECT id FROM app_private.meter_captures WHERE reading_id=(s->>'endReadingId')::uuid));
  INSERT INTO app_private.meter_capture_evidence_links(organization_id,document_kind,document_id,contract_id,meter_id,source,start_reading_id,end_reading_id,linked_by)
   VALUES(p_org,p_kind,p_document,p_contract,(s->>'meterId')::uuid,v_snapshot,(s->>'startReadingId')::uuid,(s->>'endReadingId')::uuid,auth.uid())
   ON CONFLICT(document_kind,document_id,meter_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links WHERE document_kind=p_kind AND document_id=p_document AND meter_id=(s->>'meterId')::uuid AND source=v_snapshot AND organization_id=p_org) THEN
   RAISE EXCEPTION 'Document already links different meter evidence' USING ERRCODE='23505'; END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.meter_capture_invoice_v1(p_organization_id uuid,p_arguments jsonb,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_contract uuid:=(p_arguments->>'p_contract_id')::uuid;v_building uuid:=(p_arguments->>'p_building_id')::uuid;
 v_key text:='invoice:'||(p_arguments->>'p_idempotency_key');v_hash text;v_old app_private.meter_capture_document_requests%ROWTYPE;
 s jsonb;it jsonb;v_items jsonb;v_result jsonb;v_invoice uuid;
BEGIN
 PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_building,'invoices.create');
 IF NOT EXISTS(SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
  WHERE c.id=v_contract AND c.organization_id=p_organization_id AND r.building_id=v_building
   AND (p_arguments->>'p_room_id' IS NULL OR r.id=(p_arguments->>'p_room_id')::uuid)) THEN RAISE EXCEPTION 'Invoice meter contract room/building mismatch' USING ERRCODE='42501'; END IF;
 IF v_key IS NULL THEN RAISE EXCEPTION 'Document key required' USING ERRCODE='22023'; END IF;
 v_hash:=md5(jsonb_build_object('args',p_arguments,'sources',p_sources)::text);
 INSERT INTO app_private.meter_capture_document_requests(organization_id,actor_id,request_key,payload_hash) VALUES(p_organization_id,auth.uid(),v_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO v_old FROM app_private.meter_capture_document_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key FOR UPDATE;
 IF v_old.payload_hash<>v_hash THEN RAISE EXCEPTION 'Document key reused with different meter evidence' USING ERRCODE='23505'; END IF;
 IF v_old.result IS NOT NULL THEN RETURN v_old.result; END IF;
 PERFORM app_private.meter_capture_validate_sources_v1(p_organization_id,v_contract,p_sources,'MONTHLY');
 IF (SELECT count(*) FROM jsonb_array_elements(p_arguments->'p_items') x WHERE x ? 'meter_source')<>jsonb_array_length(p_sources)
  OR (SELECT count(DISTINCT x->>'sortOrder') FROM jsonb_array_elements(p_sources) x)<>jsonb_array_length(p_sources) THEN RAISE EXCEPTION 'Every source must identify one invoice line' USING ERRCODE='22023'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
  IF s->>'month' IS DISTINCT FROM p_arguments->>'p_billing_month' THEN RAISE EXCEPTION 'Meter source billing month mismatch' USING ERRCODE='22023'; END IF;
  SELECT x INTO it FROM jsonb_array_elements(p_arguments->'p_items') WITH ORDINALITY q(x,n)
   WHERE COALESCE((x->>'sort_order')::int,n::int)=(s->>'sortOrder')::int;
  IF it IS NULL OR it->'meter_source' IS DISTINCT FROM s OR (it->>'previous_reading')::numeric IS DISTINCT FROM (s->>'previousReading')::numeric OR
   (it->>'current_reading')::numeric IS DISTINCT FROM (s->>'currentReading')::numeric OR
   NOT EXISTS(SELECT 1 FROM public.meters sm WHERE sm.id=(s->>'meterId')::uuid AND sm.organization_id=p_organization_id AND
    ((it->>'service_id')::uuid IS NOT DISTINCT FROM sm.service_id OR (sm.service_id IS NULL AND EXISTS(SELECT 1 FROM public.contract_services cs WHERE cs.organization_id=p_organization_id AND cs.contract_id=v_contract AND cs.service_id=(it->>'service_id')::uuid)))) THEN
   RAISE EXCEPTION 'Invoice line must use the selected meter values' USING ERRCODE='22023'; END IF;
  IF it->>'quantity' IS NULL OR it->>'unit_price' IS NULL OR it->>'coefficient' IS NULL OR it->>'amount' IS NULL
   OR EXISTS(SELECT 1 FROM unnest(ARRAY[it->>'quantity',it->>'unit_price',it->>'coefficient',it->>'amount']) n WHERE n IN ('NaN','Infinity','-Infinity'))
   OR round((it->>'quantity')::numeric,2)<>(s->>'currentReading')::numeric-(s->>'previousReading')::numeric
   OR (it->>'unit_price')::numeric<0 OR (it->>'coefficient')::numeric<0 OR (it->>'amount')::numeric<0
   OR round((it->>'amount')::numeric,2)<>round((it->>'unit_price')::numeric*((s->>'currentReading')::numeric-(s->>'previousReading')::numeric)*(it->>'coefficient')::numeric,2) THEN
   RAISE EXCEPTION 'Meter invoice amount must equal confirmed consumption times rate and coefficient' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(x-'meter_source' ORDER BY n),'[]') INTO v_items FROM jsonb_array_elements(p_arguments->'p_items') WITH ORDINALITY q(x,n);
 IF COALESCE((p_arguments->>'p_applied_credit')::numeric,0)>0 THEN
  v_result:=app_private.meter_capture_invoke_writer_v1('create_invoice_with_credit_v1',jsonb_set(p_arguments,'{p_items}',v_items));
 ELSE
  v_result:=app_private.meter_capture_invoke_writer_v1('create_invoice_v1',jsonb_set(p_arguments-'p_non_credit_discount_amount','{p_items}',v_items));
 END IF;
 v_invoice:=(v_result->>'invoice_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=v_invoice AND organization_id=p_organization_id AND contract_id=v_contract AND building_id=v_building) THEN RAISE EXCEPTION 'Invoice writer returned mismatched document' USING ERRCODE='55000'; END IF;
 PERFORM app_private.meter_capture_attach_v1(p_organization_id,'INVOICE',v_invoice,v_contract,p_sources);
 UPDATE app_private.meter_capture_document_requests SET result=v_result WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.meter_capture_exit_v1(p_organization_id uuid,p_rpc_name text,p_arguments jsonb,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_contract uuid;v_building uuid;v_date date;v_key text:='exit:'||(p_arguments->>'p_idempotency_key');v_hash text;
 v_old app_private.meter_capture_document_requests%ROWTYPE;v_args jsonb:=p_arguments;v_result jsonb;v_extra jsonb;s jsonb;it jsonb;v_settlement jsonb;v_invoice uuid;
BEGIN
 IF p_rpc_name NOT IN ('confirm_contract_return_v1','finalize_contract_exit_case_v1','finalize_contract_transfer_exit_v1') OR (p_arguments->>'p_organization_id')::uuid IS DISTINCT FROM p_organization_id THEN RAISE EXCEPTION 'Wrong exit writer/organization' USING ERRCODE='42501'; END IF;
 IF p_rpc_name='confirm_contract_return_v1' THEN
  v_contract:=(p_arguments->>'p_contract_id')::uuid;v_date:=(p_arguments->>'p_actual_move_out_on')::date;
  IF p_arguments->>'p_settlement_mode' IS DISTINCT FROM 'IMMEDIATE' THEN RAISE EXCEPTION 'Evidence settlement requires immediate mode' USING ERRCODE='22023'; END IF;
 ELSE SELECT contract_id,actual_move_out_on INTO v_contract,v_date FROM public.contract_exit_cases WHERE id=(p_arguments->>'p_case_id')::uuid AND organization_id=p_organization_id; END IF;
 SELECT r.building_id INTO v_building FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id WHERE c.id=v_contract AND c.organization_id=p_organization_id AND c.deleted_at IS NULL;
 PERFORM app_private.meter_capture_scope_v1(p_organization_id,v_building,'contracts.edit');
 IF v_key IS NULL THEN RAISE EXCEPTION 'Document key required' USING ERRCODE='22023'; END IF;
 v_hash:=md5(jsonb_build_object('rpc',p_rpc_name,'args',p_arguments,'sources',p_sources)::text);
 INSERT INTO app_private.meter_capture_document_requests(organization_id,actor_id,request_key,payload_hash) VALUES(p_organization_id,auth.uid(),v_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO v_old FROM app_private.meter_capture_document_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key FOR UPDATE;
 IF v_old.payload_hash<>v_hash THEN RAISE EXCEPTION 'Exit key reused with different meter evidence' USING ERRCODE='23505'; END IF;
 IF v_old.result IS NOT NULL THEN RETURN v_old.result; END IF;
 PERFORM app_private.meter_capture_validate_sources_v1(p_organization_id,v_contract,p_sources,'MOVE_OUT');
 IF (SELECT count(*) FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') x WHERE x ? 'meter_source')<>jsonb_array_length(p_sources) THEN RAISE EXCEPTION 'Every exit source must identify one charge line' USING ERRCODE='22023'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
  IF (s->>'readingDate')::date IS DISTINCT FROM v_date THEN RAISE EXCEPTION 'Exit meter must match actual move-out date' USING ERRCODE='22023'; END IF;
  SELECT x INTO it FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') x WHERE x->'meter_source'=s;
  IF it IS NULL OR it->>'kind' IS DISTINCT FROM 'ELECTRIC' OR (it->>'previous_reading')::numeric IS DISTINCT FROM (s->>'previousReading')::numeric
   OR (it->>'current_reading')::numeric IS DISTINCT FROM (s->>'currentReading')::numeric THEN RAISE EXCEPTION 'Exit line must use selected meter evidence' USING ERRCODE='22023'; END IF;
  IF it->>'unit_price' IS NULL OR it->>'amount' IS NULL OR it->>'unit_price' IN ('NaN','Infinity','-Infinity') OR it->>'amount' IN ('NaN','Infinity','-Infinity')
   OR (it->>'unit_price')::numeric<0 OR (it->>'amount')::numeric<0 OR (it->>'amount')::numeric<>round(((s->>'currentReading')::numeric-(s->>'previousReading')::numeric)*(it->>'unit_price')::numeric) THEN
   RAISE EXCEPTION 'Exit electric amount must equal confirmed consumption times rate' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Existing termination helper creates readings when meter_id is present. Omit it only
 -- for a validated capture source: the confirmed TLY reading is already retained, even at zero kWh.
 SELECT COALESCE(jsonb_agg(CASE WHEN x ? 'meter_source' THEN x-'meter_source'-'meter_id' ELSE x END ORDER BY n),'[]') INTO v_extra
  FROM jsonb_array_elements(p_arguments#>'{p_settlement,extra_charges}') WITH ORDINALITY q(x,n);
 v_args:=jsonb_set(v_args,'{p_settlement,extra_charges}',v_extra);
 v_result:=app_private.meter_capture_invoke_writer_v1(p_rpc_name,v_args);
 IF NOT EXISTS(SELECT 1 FROM public.contract_exit_cases WHERE id=(v_result->>'id')::uuid AND organization_id=p_organization_id AND contract_id=v_contract AND state='FINALIZED') THEN RAISE EXCEPTION 'Exit writer did not finalize expected case' USING ERRCODE='55000'; END IF;
 PERFORM app_private.meter_capture_attach_v1(p_organization_id,'EXIT',(v_result->>'id')::uuid,v_contract,p_sources);
 SELECT settlement_result INTO v_settlement FROM public.contract_exit_cases WHERE id=(v_result->>'id')::uuid AND organization_id=p_organization_id;
 v_settlement:=COALESCE(v_settlement->'termination',v_settlement);
 FOR v_invoice IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(v_settlement->>'settlement_invoice_id',v_settlement->>'extra_invoice_id')) WHERE value IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=v_invoice AND organization_id=p_organization_id AND contract_id=v_contract AND building_id=v_building) THEN RAISE EXCEPTION 'Settlement invoice scope mismatch' USING ERRCODE='55000'; END IF;
  PERFORM app_private.meter_capture_attach_v1(p_organization_id,'INVOICE',v_invoice,v_contract,p_sources);
 END LOOP;
 UPDATE app_private.meter_capture_document_requests SET result=v_result WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_key=v_key;
 RETURN v_result;
END $$;

CREATE TABLE IF NOT EXISTS app_private.meter_capture_frame_receipts (
 object_key text NOT NULL, capture_id uuid NOT NULL REFERENCES app_private.meter_captures(id),
 job_id uuid NOT NULL REFERENCES app_private.meter_capture_jobs(id),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 timestamp_seconds numeric NOT NULL CHECK(timestamp_seconds>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(job_id,object_key,timestamp_seconds)
);
ALTER TABLE app_private.meter_capture_frame_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.meter_capture_frame_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.meter_capture_media_receipt_v1(p_capture_id uuid,p_object_key text,p_sha256 text,p_size_bytes bigint,p_mime_type text,p_duration_seconds numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;
BEGIN
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_capture_id FOR UPDATE;
 IF NOT FOUND OR c.object_key IS DISTINCT FROM p_object_key OR c.sha256 IS DISTINCT FROM p_sha256 OR c.size_bytes IS DISTINCT FROM p_size_bytes OR c.mime_type IS DISTINCT FROM p_mime_type THEN RAISE EXCEPTION 'Original media receipt mismatch' USING ERRCODE='22023'; END IF;
 IF p_mime_type LIKE 'video/%' AND p_duration_seconds IS NOT NULL AND (p_duration_seconds<=0 OR p_duration_seconds>60 OR abs(p_duration_seconds-c.duration_seconds)>1) THEN RAISE EXCEPTION 'Clip duration invalid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='meter-capture-media' AND name=p_object_key) THEN RAISE EXCEPTION 'Original object not persisted' USING ERRCODE='55000'; END IF;
 UPDATE app_private.meter_captures SET media_received=true,received_at=COALESCE(received_at,clock_timestamp()) WHERE id=c.id;
 RETURN jsonb_build_object('captureId',c.id,'mediaReceived',true);
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_job_json_v1(p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('jobId',j.id,'captureId',c.id,'organizationId',c.organization_id,'leaseToken',j.lease_token,
  'media',jsonb_build_array(jsonb_build_object('id',c.id,'objectKey',c.object_key,'mimeType',c.mime_type,'sizeBytes',c.size_bytes,'sha256',c.sha256,
    'kind',CASE WHEN c.mime_type LIKE 'video/%' THEN 'video' ELSE 'image' END,'durationSeconds',c.duration_seconds)),
  'meter',c.profile_snapshot||jsonb_build_object('id',c.meter_id))
 FROM app_private.meter_capture_jobs j JOIN app_private.meter_captures c ON c.id=j.capture_id WHERE j.id=p_job
$$;
CREATE OR REPLACE FUNCTION public.meter_capture_claim_v1(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE j app_private.meter_capture_jobs%ROWTYPE;
BEGIN
 IF NULLIF(btrim(p_worker_id),'') IS NULL OR length(p_worker_id)>100 THEN RAISE EXCEPTION 'Invalid worker identifier' USING ERRCODE='22023'; END IF;
 WITH exhausted AS (
  UPDATE app_private.meter_capture_jobs SET state='FAILED',lease_until=NULL
   WHERE state='RUNNING' AND lease_until<clock_timestamp() AND attempts>=3 RETURNING capture_id
 )
 UPDATE app_private.meter_captures cap SET status=CASE WHEN cap.status='CONFIRMED' THEN 'CONFIRMED' ELSE 'REVIEW' END,
  issues=cap.issues||'["WORKER_LEASE_EXHAUSTED"]'::jsonb,version=cap.version+1
 FROM exhausted WHERE cap.id=exhausted.capture_id;
 SELECT jobs.* INTO j FROM app_private.meter_capture_jobs jobs JOIN app_private.meter_captures c ON c.id=jobs.capture_id
  WHERE c.media_received AND jobs.created_at<=clock_timestamp() AND (jobs.state='QUEUED' OR (jobs.state='RUNNING' AND jobs.lease_until<clock_timestamp())) AND jobs.attempts<3
  ORDER BY jobs.created_at FOR UPDATE OF jobs SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE app_private.meter_capture_jobs SET state='RUNNING',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',attempts=attempts+1 WHERE id=j.id;
 UPDATE app_private.meter_captures SET status='PROCESSING',version=version+1 WHERE id=j.capture_id AND status<>'CONFIRMED';
 RETURN app_private.meter_capture_job_json_v1(j.id);
END $$;
CREATE OR REPLACE FUNCTION public.meter_capture_worker_context_v1(p_job_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_jobs WHERE id=p_job_id AND lease_token=p_lease_token AND state='RUNNING' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'Worker lease expired' USING ERRCODE='PT409'; END IF;
 RETURN app_private.meter_capture_job_json_v1(p_job_id);
END $$;
CREATE OR REPLACE FUNCTION public.meter_capture_evidence_receipt_v1(p_job_id uuid,p_lease_token uuid,p_object_key text,p_sha256 text,p_timestamp_seconds numeric)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;
BEGIN
 PERFORM public.meter_capture_worker_context_v1(p_job_id,p_lease_token);
 SELECT cap.* INTO c FROM app_private.meter_captures cap JOIN app_private.meter_capture_jobs j ON j.capture_id=cap.id WHERE j.id=p_job_id;
 IF p_object_key IS DISTINCT FROM c.organization_id::text||'/meter-captures/'||c.id::text||'/evidence/'||p_sha256||'.jpg'
  OR p_timestamp_seconds IS NULL OR p_timestamp_seconds<0 OR p_timestamp_seconds>COALESCE(c.duration_seconds,0)
  OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='meter-capture-media' AND name=p_object_key) THEN RAISE EXCEPTION 'Evidence frame scope/persistence mismatch' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.meter_capture_frame_receipts(object_key,capture_id,job_id,sha256,timestamp_seconds)
 VALUES(p_object_key,c.id,p_job_id,p_sha256,p_timestamp_seconds) ON CONFLICT(job_id,object_key,timestamp_seconds) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_frame_receipts WHERE object_key=p_object_key AND capture_id=c.id AND job_id=p_job_id AND sha256=p_sha256 AND timestamp_seconds=p_timestamp_seconds) THEN RAISE EXCEPTION 'Evidence frame receipt reused differently' USING ERRCODE='23505'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.meter_capture_complete_v1(p_job_id uuid,p_lease_token uuid,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE j app_private.meter_capture_jobs%ROWTYPE;c app_private.meter_captures%ROWTYPE;v_issues jsonb;engine jsonb;frame jsonb;v_count integer;
BEGIN
 SELECT * INTO j FROM app_private.meter_capture_jobs WHERE id=p_job_id FOR UPDATE;
 IF j.state='DONE' AND j.lease_token=p_lease_token THEN
  IF (SELECT result FROM app_private.meter_capture_results WHERE job_id=j.id) IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'Immutable worker result differs' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('ok',true);
 END IF;
 PERFORM public.meter_capture_worker_context_v1(p_job_id,p_lease_token);
 SELECT * INTO c FROM app_private.meter_captures WHERE id=j.capture_id FOR UPDATE;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR jsonb_typeof(p_result->'issues') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid worker output' USING ERRCODE='22023'; END IF;
 v_issues:=p_result->'issues';
 IF p_result->>'mediaValidated' IS DISTINCT FROM 'true' THEN v_issues:=v_issues||'"MEDIA_VALIDATION_FAILED"'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_captures other WHERE other.organization_id=c.organization_id AND other.sha256=c.sha256 AND other.id<>c.id) THEN v_issues:=v_issues||'"DUPLICATE_MEDIA"'::jsonb; END IF;
 IF c.mime_type LIKE 'video/%' AND (p_result->>'mediaValidated' IS DISTINCT FROM 'true' OR (p_result->>'durationSeconds')::numeric IS NULL OR (p_result->>'durationSeconds')::numeric<=0 OR (p_result->>'durationSeconds')::numeric>60) THEN
  v_issues:=v_issues||'"MEDIA_VALIDATION_FAILED"'::jsonb; END IF;
 IF p_result#>>'{identity,ambiguous}' IS DISTINCT FROM 'false' OR p_result#>'{identity,qrTokens}' IS DISTINCT FROM jsonb_build_array(c.profile_snapshot->>'qrToken') THEN v_issues:=v_issues||'"IDENTITY_UNVERIFIED"'::jsonb; END IF;
 FOR engine IN SELECT value FROM jsonb_each(jsonb_build_object('server',p_result->'server','ai',p_result->'ai')) LOOP
  IF engine->>'status' IS NULL OR engine->>'status' NOT IN ('ok','unreadable','error') OR NULLIF(engine->>'version','') IS NULL THEN RAISE EXCEPTION 'Engine result requires status and version' USING ERRCODE='22023'; END IF;
  IF engine->>'status'<>'ok' THEN v_issues:=v_issues||'"ENGINE_INCOMPLETE"'::jsonb;CONTINUE; END IF;
  IF engine->>'value' IS NULL OR engine->>'value' !~ '^\d{1,8}(\.\d{1,2})?$' OR engine->>'unit' IS DISTINCT FROM 'kWh' OR engine->>'registerCode' IS DISTINCT FROM c.profile_snapshot->>'registerCode' THEN
   v_issues:=v_issues||'"WRONG_REGISTER_OR_VALUE"'::jsonb;CONTINUE; END IF;
  IF round((engine->>'value')::numeric,(c.profile_snapshot->>'decimalPlaces')::int)<>(engine->>'value')::numeric THEN v_issues:=v_issues||'"DECIMAL_MISMATCH"'::jsonb; END IF;
  IF jsonb_typeof(engine->'frames') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Evidence frame list required' USING ERRCODE='22023'; END IF;
  FOR frame IN SELECT value FROM jsonb_array_elements(engine->'frames') LOOP
   IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_frame_receipts e WHERE e.capture_id=c.id AND e.job_id=j.id AND e.object_key=frame->>'objectKey' AND e.timestamp_seconds=(frame->>'timestampSeconds')::numeric) THEN RAISE EXCEPTION 'Unverified frame cannot be cited' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT count(DISTINCT x->>'timestampSeconds') INTO v_count FROM jsonb_array_elements(engine->'frames') x;
  IF v_count<(CASE WHEN c.mime_type LIKE 'video/%' THEN 2 ELSE 1 END) THEN v_issues:=v_issues||'"INSUFFICIENT_CLEAR_FRAMES"'::jsonb; END IF;
 END LOOP;
 IF p_result#>>'{server,value}' IS DISTINCT FROM p_result#>>'{ai,value}' THEN v_issues:=v_issues||'"ENGINE_DISAGREEMENT"'::jsonb; END IF;
 IF c.status='CONFIRMED' AND (p_result#>>'{server,value}' IS DISTINCT FROM c.confirmed_value::text OR p_result#>>'{ai,value}' IS DISTINCT FROM c.confirmed_value::text) THEN v_issues:=v_issues||'"LATE_READING_REQUIRES_REVIEW"'::jsonb; END IF;
 INSERT INTO app_private.meter_capture_results(job_id,capture_id,result) VALUES(j.id,c.id,p_result);
 UPDATE app_private.meter_capture_jobs SET state='DONE',lease_until=NULL WHERE id=j.id;
 UPDATE app_private.meter_captures SET issues=v_issues,media_validated=NOT v_issues ? 'MEDIA_VALIDATION_FAILED',
  version=version+1,status=CASE WHEN status='CONFIRMED' THEN status ELSE 'REVIEW' END WHERE id=c.id;
 IF (p_result#>>'{server,status}'='error' OR p_result#>>'{ai,status}'='error') AND j.generation<3 AND NOT v_issues ? 'MEDIA_VALIDATION_FAILED' THEN
  INSERT INTO app_private.meter_capture_jobs(capture_id,generation,created_at) VALUES(c.id,j.generation+1,clock_timestamp()+interval '1 minute') ON CONFLICT DO NOTHING;
 END IF;
 RETURN jsonb_build_object('ok',true,'issues',v_issues);
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_anomaly_v1(p_capture_id uuid,p_value numeric,p_previous numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_median numeric;v_previous numeric:=p_previous;
BEGIN
 IF p_value IS NULL THEN RETURN '[]'::jsonb; END IF;
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_capture_id;
 SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY delta)::numeric INTO v_median FROM (
  SELECT current_reading-previous_reading delta FROM public.meter_readings r WHERE r.organization_id=c.organization_id
   AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.deleted_at IS NULL AND r.status='APPROVED'
   AND r.reading_date<=c.reading_date AND r.created_at<c.created_at AND r.current_reading>r.previous_reading
   ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 3) h;
 IF v_median IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF v_previous IS NULL THEN
  SELECT current_reading INTO v_previous FROM public.meter_readings r WHERE r.organization_id=c.organization_id AND r.meter_id=c.meter_id AND r.contract_id=c.contract_id
   AND r.deleted_at IS NULL AND r.status='APPROVED' AND r.reading_date<=c.reading_date AND r.created_at<c.created_at ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 1;
 END IF;
 IF v_previous IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF p_value-v_previous>GREATEST(100,3*v_median) THEN RETURN '["ABNORMAL_INCREASE"]'::jsonb; END IF;
 RETURN '[]'::jsonb;
END $$;

-- Confirmation pins the reader result and its evidence. A later retry remains in
-- history but cannot silently replace the proof that the manager actually saw.
CREATE OR REPLACE FUNCTION app_private.meter_capture_selected_frame_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('objectKey',e.object_key,'timestampSeconds',e.timestamp_seconds)
 FROM app_private.meter_captures c
 JOIN LATERAL (SELECT res.job_id,res.result FROM app_private.meter_capture_results res
  WHERE res.capture_id=c.id AND res.created_at<=COALESCE(c.confirmed_at,'infinity'::timestamptz)
  ORDER BY res.created_at DESC LIMIT 1) r ON true
 JOIN app_private.meter_capture_frame_receipts e ON e.capture_id=c.id AND e.job_id=r.job_id
 WHERE c.id=p_id
 ORDER BY CASE
  WHEN r.result#>>'{server,status}'='ok' AND (r.result#>'{server,frames}') @> jsonb_build_array(jsonb_build_object('objectKey',e.object_key,'timestampSeconds',e.timestamp_seconds)) THEN 0
  WHEN r.result#>>'{ai,status}'='ok' AND (r.result#>'{ai,frames}') @> jsonb_build_array(jsonb_build_object('objectKey',e.object_key,'timestampSeconds',e.timestamp_seconds)) THEN 1
  ELSE 2 END,e.timestamp_seconds,e.object_key LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_json_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('id',c.id,'clientId',c.client_id,'organizationId',c.organization_id,'meterId',c.meter_id,
  'buildingId',c.building_id,'roomId',c.room_id,'contractId',c.contract_id,'purpose',c.purpose,'readingDate',c.reading_date,
  'orgId',c.organization_id,'month',c.month,'capturedAt',c.captured_at,'receivedAt',c.received_at,'status',CASE WHEN c.status='AWAITING_UPLOAD' THEN 'UPLOADING' ELSE c.status END,'version',c.version,
  'mimeType',c.mime_type,'sizeBytes',c.size_bytes,'sha256',c.sha256,'durationSeconds',c.duration_seconds,
  'objectKey',c.object_key,'originalObjectKey',c.object_key,'mediaReceived',c.media_received,'mediaValidated',c.media_validated,'readingId',c.reading_id,
  'imageObjectKey',CASE WHEN c.mime_type LIKE 'image/%' THEN c.object_key ELSE app_private.meter_capture_selected_frame_v1(c.id)->>'objectKey' END,
  'videoObjectKey',CASE WHEN c.mime_type LIKE 'video/%' THEN c.object_key END,
  'value',c.confirmed_value::text,'reason',c.reason,'issues',c.issues||app_private.meter_capture_anomaly_v1(c.id,
   CASE WHEN COALESCE(c.confirmed_value::text,r.result#>>'{server,value}',r.result#>>'{ai,value}')~'^\d{1,8}(\.\d{1,2})?$'
   THEN COALESCE(c.confirmed_value::text,r.result#>>'{server,value}',r.result#>>'{ai,value}')::numeric END,c.previous_value),'result',r.result,
  'proposedValue',COALESCE(c.confirmed_value::text,r.result#>>'{server,value}',r.result#>>'{ai,value}'),
  'serverResult',r.result->'server','aiResult',r.result->'ai','evidenceUrl',NULL,'videoUrl',NULL,'confirmedReadingId',c.reading_id)
 FROM app_private.meter_captures c LEFT JOIN LATERAL (SELECT result FROM app_private.meter_capture_results res WHERE res.capture_id=c.id
  AND res.created_at<=COALESCE(c.confirmed_at,'infinity'::timestamptz) ORDER BY res.created_at DESC LIMIT 1) r ON true WHERE c.id=p_id
$$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_catalog_v1(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('meters',COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'meterId',m.id,'code',m.code,
  'orgId',m.organization_id,'name',m.name,'buildingId',m.building_id,'buildingName',b.name,'roomId',m.room_id,'roomName',r.name,'meterType',m.meter_type,
  'serviceId',m.service_id,'serialNumber',COALESCE(p.serial_number,m.serial_number),'qrText',CASE WHEN p.revoked_at IS NULL THEN 'ihome-meter:'||p.qr_token END,
  'profile',CASE WHEN p.meter_id IS NULL THEN NULL ELSE jsonb_build_object('version',p.version,'serial',p.serial_number,
    'displayKind',p.display_kind,'decimalPlaces',p.decimal_places,'registerCode',p.register_code,'referencePath',p.reference_path,'revoked',p.revoked_at IS NOT NULL) END
 ) ORDER BY b.name,r.name,m.code),'[]'))
 FROM public.meters m JOIN public.buildings b ON b.id=m.building_id AND b.organization_id=p_org
 JOIN public.rooms r ON r.id=m.room_id AND r.organization_id=p_org AND r.building_id=b.id
 LEFT JOIN app_private.meter_capture_profiles p ON p.meter_id=m.id AND p.organization_id=p_org
 WHERE m.organization_id=p_org AND m.deleted_at IS NULL AND m.status='ACTIVE' AND m.meter_type::text='ELECTRICITY'
 AND EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'meter_readings.view',m.building_id,NULL) a WHERE a.allowed)
$$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_reading_point_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT jsonb_build_object('readingId',r.id,'value',r.current_reading::text,'version',r.updated_at::text,
  'readingDate',r.reading_date,'captureId',c.id,'kind','reading')
 FROM public.meter_readings r LEFT JOIN app_private.meter_captures c ON c.reading_id=r.id AND c.status='CONFIRMED' WHERE r.id=p_id
$$;

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
   AND r.status='APPROVED' AND r.deleted_at IS NULL AND r.reading_date>=c.start_date AND r.reading_date<v_from
   AND v_purpose='MONTHLY'
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  IF v_purpose='MOVE_OUT' THEN
   SELECT l.end_reading_id INTO v_id FROM app_private.meter_capture_evidence_links l JOIN public.invoices i ON i.id=l.document_id
    WHERE l.document_kind='INVOICE' AND l.organization_id=p_org AND l.contract_id=c.id AND l.meter_id=m.id
    AND i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
    AND i.billing_month<=p_payload->>'month' AND (l.source->>'readingDate')::date<=v_to
    ORDER BY (l.source->>'readingDate')::date DESC,i.created_at DESC LIMIT 1;
   IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  END IF;
  IF v_start IS NULL AND (SELECT count(*) FROM public.meters x WHERE x.organization_id=p_org AND x.room_id=c.room_id AND x.status='ACTIVE' AND x.deleted_at IS NULL AND x.meter_type::text='ELECTRICITY')=1 THEN
   SELECT jsonb_build_object('readingId',NULL,'value',ii.current_reading::text,'version','invoice:'||i.id::text||':'||ii.id::text||':'||i.updated_at::text,
    'captureId',NULL,'kind','invoice','readingDate',COALESCE(ii.to_date,i.issue_date)) INTO v_start
   FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id=i.id WHERE i.organization_id=p_org AND i.contract_id=c.id
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
   WHERE r.organization_id=p_org AND r.contract_id=c.id AND r.meter_id=m.id AND r.status='APPROVED' AND r.deleted_at IS NULL
    AND r.reading_date>=v_from AND r.reading_date<=v_to AND cap.purpose=v_purpose AND cap.status='CONFIRMED'
    AND (v_purpose<>'MOVE_OUT' OR r.reading_date=v_to)
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN v_end:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('meterId',m.id,'meterName',COALESCE(m.name,m.code),'meterType',m.meter_type,'serviceId',m.service_id,
   'decimalPlaces',COALESCE(m.decimal_places,2),'registerCode',COALESCE(m.register_code,''),'start',v_start,'end',v_end,
   'issues',(CASE WHEN v_start IS NULL THEN '["MISSING_START"]' ELSE '[]' END)::jsonb||(CASE WHEN v_end IS NULL THEN '["MISSING_END"]' ELSE '[]' END)::jsonb));
 END LOOP;
 RETURN jsonb_build_object('meters',v_rows);
END $$;

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
    'timestampSeconds',app_private.meter_capture_selected_frame_v1(c.id)->'timestampSeconds'));
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
   SELECT current_reading INTO v_previous FROM public.meter_readings WHERE meter_id=c.meter_id AND contract_id=c.contract_id AND organization_id=p_organization_id
    AND deleted_at IS NULL AND status='APPROVED' AND reading_date>=ct.start_date AND reading_date<=c.reading_date ORDER BY reading_date DESC,created_at DESC,id DESC LIMIT 1;
   IF v_previous IS NULL THEN
    SELECT (x#>>'{start,value}')::numeric INTO v_previous FROM jsonb_array_elements(app_private.meter_capture_resolve_billing_v1(p_organization_id,
     jsonb_build_object('contractId',c.contract_id,'month',c.month,'readingDate',c.reading_date,'purpose',c.purpose))->'meters') x WHERE x->>'meterId'=c.meter_id::text;
   END IF;
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

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('meter-capture-media','meter-capture-media',false,104857600,ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
CREATE OR REPLACE FUNCTION public.meter_capture_storage_allowed_v1(p_name text,p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_org uuid;v_building uuid;v_allowed boolean;
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
 SELECT cap.* INTO c FROM app_private.meter_captures cap WHERE cap.organization_id::text=split_part(p_name,'/',1)
  AND cap.id::text=split_part(p_name,'/',3) AND split_part(p_name,'/',2)='meter-captures';
 IF c.id IS NULL OR NOT COALESCE(c.organization_id=ANY(public.my_org_ids()),false) THEN RETURN false; END IF;
 IF p_write AND (c.object_key<>p_name OR c.actor_id<>auth.uid() OR c.media_received) THEN RETURN false; END IF;
 IF NOT p_write AND p_name<>c.object_key AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_frame_receipts WHERE capture_id=c.id AND object_key=p_name) THEN RETURN false; END IF;
 SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,CASE WHEN p_write THEN 'meter_readings.create' ELSE 'meter_readings.view' END,c.building_id,NULL);
 RETURN COALESCE(v_allowed,false);
END $$;
DROP POLICY IF EXISTS meter_capture_storage_insert ON storage.objects;
CREATE POLICY meter_capture_storage_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='meter-capture-media' AND public.meter_capture_storage_allowed_v1(name,true));
DROP POLICY IF EXISTS meter_capture_storage_read ON storage.objects;
CREATE POLICY meter_capture_storage_read ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='meter-capture-media' AND public.meter_capture_storage_allowed_v1(name,false));
-- Restrictive guards also cover broad legacy policies on storage.objects.
DROP POLICY IF EXISTS meter_capture_storage_private_read ON storage.objects;
CREATE POLICY meter_capture_storage_private_read ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
 USING(bucket_id<>'meter-capture-media' OR public.meter_capture_storage_allowed_v1(name,false));
DROP POLICY IF EXISTS meter_capture_storage_scoped_insert ON storage.objects;
CREATE POLICY meter_capture_storage_scoped_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(bucket_id<>'meter-capture-media' OR public.meter_capture_storage_allowed_v1(name,true));
DROP POLICY IF EXISTS meter_capture_storage_no_update ON storage.objects;
CREATE POLICY meter_capture_storage_no_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(bucket_id<>'meter-capture-media') WITH CHECK(bucket_id<>'meter-capture-media');
DROP POLICY IF EXISTS meter_capture_storage_no_delete ON storage.objects;
CREATE POLICY meter_capture_storage_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated
 USING(bucket_id<>'meter-capture-media');

DO $acl$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','app_private') AND p.proname LIKE 'meter_capture_%v1' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.meter_capture_v1(uuid,text,jsonb),public.meter_capture_invoice_v1(uuid,jsonb,jsonb),
 public.meter_capture_exit_v1(uuid,text,jsonb,jsonb),public.meter_capture_storage_allowed_v1(text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.meter_capture_storage_allowed_v1(text,boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.meter_capture_claim_v1(text),public.meter_capture_worker_context_v1(uuid,uuid),
 public.meter_capture_media_receipt_v1(uuid,text,text,bigint,text,numeric),public.meter_capture_evidence_receipt_v1(uuid,uuid,text,text,numeric),
 public.meter_capture_complete_v1(uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
