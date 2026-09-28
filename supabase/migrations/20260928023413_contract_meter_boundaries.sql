-- Physical handover facts only. No billing, consumption or money writer changes.
CREATE TABLE IF NOT EXISTS public.contract_meter_boundary_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('MOVE_OUT','MOVE_IN')),
  effective_on date NOT NULL,
  state text NOT NULL CHECK(state IN ('VERIFIED','MISSING','REVIEW')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  reason text,
  recorded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  initial_payload_hash text NOT NULL,
  affected_invoice_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,contract_id,kind),
  CHECK(state='VERIFIED' OR NULLIF(btrim(reason),'') IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS public.contract_meter_boundaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.contract_meter_boundary_sets(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
  meter_id uuid NOT NULL REFERENCES public.meters(id) ON DELETE RESTRICT,
  meter_code text, meter_type text,
  kind text NOT NULL CHECK(kind IN ('MOVE_OUT','MOVE_IN')),
  effective_on date NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('VERIFIED','MISSING','REVIEW')),
  reading numeric CHECK(reading>=0 AND reading<>'NaN'::numeric AND reading<>'Infinity'::numeric),
  measured_at timestamptz,
  evidence text,
  recorded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(set_id,revision,meter_id),
  CHECK((state='MISSING' AND reading IS NULL AND measured_at IS NULL) OR (state IN ('VERIFIED','REVIEW') AND reading IS NOT NULL AND measured_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.contract_meter_boundary_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.contract_meter_boundary_sets(id) ON DELETE RESTRICT,
  revision bigint NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(btrim(reason))>0),
  idempotency_key text NOT NULL, payload_hash text NOT NULL,
  before_snapshot jsonb NOT NULL, requested_payload jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(set_id,revision),UNIQUE(set_id,actor_id,idempotency_key)
);
ALTER TABLE public.meter_readings ADD COLUMN IF NOT EXISTS boundary_id uuid REFERENCES public.contract_meter_boundaries(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS contract_meter_boundary_interval_idx ON public.contract_meter_boundaries(organization_id,contract_id,meter_id,measured_at,id);
REVOKE ALL ON public.contract_meter_boundary_sets,public.contract_meter_boundaries,app_private.contract_meter_boundary_history FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.contract_meter_boundary_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_meter_boundaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_meter_boundary_sets_scope_select ON public.contract_meter_boundary_sets;
CREATE POLICY contract_meter_boundary_sets_scope_select ON public.contract_meter_boundary_sets FOR SELECT TO authenticated
  USING(organization_id=ANY(public.my_org_ids()) AND public.can_access_building(building_id) AND public.can_do_on_building('contracts','view',building_id));
DROP POLICY IF EXISTS contract_meter_boundary_sets_hide_sandbox_admin ON public.contract_meter_boundary_sets;
CREATE POLICY contract_meter_boundary_sets_hide_sandbox_admin ON public.contract_meter_boundary_sets AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
DROP POLICY IF EXISTS contract_meter_boundaries_scope_select ON public.contract_meter_boundaries;
CREATE POLICY contract_meter_boundaries_scope_select ON public.contract_meter_boundaries FOR SELECT TO authenticated
  USING(organization_id=ANY(public.my_org_ids()) AND public.can_access_building(building_id) AND public.can_do_on_building('contracts','view',building_id));
DROP POLICY IF EXISTS contract_meter_boundaries_hide_sandbox_admin ON public.contract_meter_boundaries;
CREATE POLICY contract_meter_boundaries_hide_sandbox_admin ON public.contract_meter_boundaries AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION app_private.assert_meter_boundary_scope_v1(p_org uuid,p_building uuid,p_action text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) OR NOT COALESCE(public.can_access_building(p_building),false)
    OR NOT COALESCE(public.can_do_on_building('contracts',p_action,p_building),false)
    OR (p_action='view' AND public.is_super_admin() AND COALESCE(p_org=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Missing handover meter permission' USING ERRCODE='42501'; END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.assert_meter_boundary_writer_v1(p_org uuid,p_building uuid,p_action text DEFAULT 'contracts.edit')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('contracts.edit','contracts.create') THEN RAISE EXCEPTION 'Unknown handover authority' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_meter_boundary_scope_v1(p_org,p_building,split_part(p_action,'.',2));
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,p_action,p_building,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Missing handover contract permission' USING ERRCODE='42501'; END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.meter_boundary_set_response_v1(p_set uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('id',s.id,'organization_id',s.organization_id,'building_id',s.building_id,'room_id',s.room_id,'contract_id',s.contract_id,
    'kind',s.kind,'effective_on',s.effective_on,'state',s.state,'revision',s.revision,'reason',s.reason,'recorded_by',s.recorded_by,
    'created_at',s.created_at,'updated_at',s.updated_at,'affected_invoice_ids',s.affected_invoice_ids,
    'readings',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'meter_id',b.meter_id,'meter_code',b.meter_code,'meter_type',b.meter_type,
      'reading',b.reading,'measured_at',b.measured_at,'evidence',b.evidence,'state',b.state,'recorded_by',b.recorded_by,'recorded_at',b.recorded_at)
      ORDER BY b.measured_at NULLS LAST,b.meter_id,b.id) FROM public.contract_meter_boundaries b WHERE b.set_id=s.id AND b.revision=s.revision),'[]'::jsonb),
    'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',h.revision,'reason',h.reason,'changed_by',h.actor_id,'changed_at',h.changed_at) ORDER BY h.revision)
      FROM app_private.contract_meter_boundary_history h WHERE h.set_id=s.id),'[]'::jsonb))
  FROM public.contract_meter_boundary_sets s WHERE s.id=p_set
$fn$;

CREATE OR REPLACE FUNCTION app_private.validate_meter_boundary_payload_v1(p_org uuid,p_room uuid,p_building uuid,p_payload jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v jsonb; v_id uuid; v_reading numeric; v_time timestamptz;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_payload->>'state' IS NULL OR p_payload->>'state' NOT IN ('VERIFIED','MISSING')
    OR jsonb_typeof(p_payload->'readings') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('state','reason','readings')) THEN
    RAISE EXCEPTION 'Invalid physical meter payload' USING ERRCODE='22023'; END IF;
  IF p_payload->>'state'='MISSING' AND (NULLIF(btrim(p_payload->>'reason'),'') IS NULL OR jsonb_array_length(p_payload->'readings')<>0) THEN
    RAISE EXCEPTION 'Missing reading needs a reason and cannot contain invented values' USING ERRCODE='22023'; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p_payload->'readings') LOOP
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('meter_id','reading','measured_at','evidence'))
      OR jsonb_typeof(v->'reading') IS DISTINCT FROM 'number' OR NULLIF(v->>'meter_id','') IS NULL OR NULLIF(v->>'measured_at','') IS NULL THEN
      RAISE EXCEPTION 'Invalid physical meter reading' USING ERRCODE='22023'; END IF;
    v_id:=(v->>'meter_id')::uuid;v_reading:=(v->>'reading')::numeric;v_time:=(v->>'measured_at')::timestamptz;
    IF v_reading<0 OR v_reading IN ('NaN'::numeric,'Infinity'::numeric) OR v_time>clock_timestamp() THEN
      RAISE EXCEPTION 'Reading must be an actual finite non-negative measurement' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.meters m WHERE m.id=v_id AND m.organization_id=p_org AND m.room_id=p_room AND m.building_id=p_building
      AND m.status='ACTIVE' AND m.deleted_at IS NULL) THEN RAISE EXCEPTION 'Meter is outside this handover room' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload->'readings'))<>(SELECT count(DISTINCT value->>'meter_id') FROM jsonb_array_elements(p_payload->'readings')) THEN
    RAISE EXCEPTION 'Duplicate handover meter' USING ERRCODE='22023'; END IF;
  IF p_payload->>'state'='VERIFIED' AND EXISTS(SELECT 1 FROM public.meters m WHERE m.organization_id=p_org AND m.room_id=p_room AND m.building_id=p_building
    AND m.status='ACTIVE' AND m.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'readings') supplied WHERE (supplied->>'meter_id')::uuid=m.id)) THEN
    RAISE EXCEPTION 'Every active room meter needs its own verified reading' USING ERRCODE='22023'; END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.insert_meter_boundary_revision_v1(p_set uuid,p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE;
BEGIN
  SELECT * INTO STRICT s FROM public.contract_meter_boundary_sets WHERE id=p_set;
  PERFORM app_private.validate_meter_boundary_payload_v1(s.organization_id,s.room_id,s.building_id,p_payload);
  INSERT INTO public.contract_meter_boundaries(set_id,organization_id,building_id,contract_id,room_id,meter_id,meter_code,meter_type,kind,effective_on,revision,state,reading,measured_at,evidence,recorded_by)
    SELECT s.id,s.organization_id,s.building_id,s.contract_id,s.room_id,m.id,m.code,m.meter_type::text,s.kind,s.effective_on,s.revision,
      CASE WHEN p_payload->>'state'='MISSING' THEN 'MISSING' ELSE s.state END,(v.value->>'reading')::numeric,(v.value->>'measured_at')::timestamptz,v.value->>'evidence',auth.uid()
    FROM public.meters m LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(p_payload->'readings') WHERE (value->>'meter_id')::uuid=m.id) v ON true
    WHERE m.organization_id=s.organization_id AND m.room_id=s.room_id AND m.building_id=s.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.record_contract_meter_boundary_set_v1(p_organization_id uuid,p_contract_id uuid,p_room_id uuid,p_kind text,p_effective_on date,p_payload jsonb,p_action text DEFAULT 'contracts.edit')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE;s public.contract_meter_boundary_sets%ROWTYPE;v_building uuid;v_hash text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong handover organization' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  SELECT building_id INTO v_building FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id;
  IF c.id IS NULL OR c.room_id IS DISTINCT FROM p_room_id OR v_building IS NULL OR NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=v_building AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'Handover subject scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_meter_boundary_writer_v1(p_organization_id,v_building,p_action);
  -- This private helper is only invoked with the contract returned by the
  -- signing transaction. xmin differs from the parent xid after a savepoint.
  IF p_action='contracts.create' AND (p_kind IS DISTINCT FROM 'MOVE_IN' OR c.created_at<transaction_timestamp()) THEN
    RAISE EXCEPTION 'Create authority can only record the incoming contract just created in this transaction' USING ERRCODE='42501'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('MOVE_IN','MOVE_OUT') OR p_effective_on IS NULL OR p_effective_on>public.org_today_v1(p_organization_id)
    OR (p_kind='MOVE_OUT' AND (c.status<>'TERMINATED' OR c.actual_end_date IS DISTINCT FROM p_effective_on))
    OR (p_kind='MOVE_IN' AND (c.status NOT IN ('ACTIVE','EXTENDED') OR c.actual_end_date IS NOT NULL OR c.start_date IS DISTINCT FROM p_effective_on)) THEN
    RAISE EXCEPTION 'Boundary must match the actual handover' USING ERRCODE='55000'; END IF;
  v_hash:=md5(p_payload::text);
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind FOR UPDATE;
  IF FOUND THEN
    IF s.room_id IS DISTINCT FROM p_room_id OR s.effective_on IS DISTINCT FROM p_effective_on OR s.initial_payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Handover meter intent already recorded differently' USING ERRCODE='23505'; END IF;
    RETURN app_private.meter_boundary_set_response_v1(s.id);
  END IF;
  PERFORM app_private.validate_meter_boundary_payload_v1(p_organization_id,p_room_id,v_building,p_payload);
  IF p_kind='MOVE_IN' AND p_payload->>'state'<>'VERIFIED' THEN RAISE EXCEPTION 'Incoming handover needs its own verified readings' USING ERRCODE='55000'; END IF;
  INSERT INTO public.contract_meter_boundary_sets(organization_id,building_id,room_id,contract_id,kind,effective_on,state,reason,recorded_by,initial_payload_hash)
    VALUES(p_organization_id,v_building,p_room_id,p_contract_id,p_kind,p_effective_on,p_payload->>'state',p_payload->>'reason',auth.uid(),v_hash) RETURNING * INTO s;
  PERFORM app_private.insert_meter_boundary_revision_v1(s.id,p_payload);
  RETURN app_private.meter_boundary_set_response_v1(s.id);
END $fn$;
CREATE OR REPLACE FUNCTION app_private.assert_contract_move_in_boundaries_v1(p_organization_id uuid,p_contract_id uuid,p_action text DEFAULT 'contracts.edit')
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE;c public.contracts%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('contracts.edit','contracts.create') THEN RAISE EXCEPTION 'Unknown handover authority' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind='MOVE_IN';
  IF c.id IS NULL OR s.id IS NULL OR s.state<>'VERIFIED' OR s.room_id IS DISTINCT FROM c.room_id THEN RAISE EXCEPTION 'B needs its own verified incoming boundary' USING ERRCODE='55000'; END IF;
  PERFORM app_private.assert_meter_boundary_scope_v1(s.organization_id,s.building_id,split_part(p_action,'.',2));
  IF p_action='contracts.create' AND c.created_at<transaction_timestamp() THEN
    RAISE EXCEPTION 'Create assertion must match its newly created contract transaction' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.meters m WHERE m.organization_id=s.organization_id AND m.room_id=s.room_id AND m.building_id=s.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.contract_meter_boundaries b WHERE b.set_id=s.id AND b.revision=s.revision AND b.meter_id=m.id AND b.state='VERIFIED' AND b.reading IS NOT NULL AND b.measured_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Incoming meter coverage changed; verify own readings' USING ERRCODE='55000'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.read_contract_meter_boundary_set_v1(p_organization_id uuid,p_contract_id uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_building uuid;v_set uuid;
BEGIN
  SELECT r.building_id INTO v_building FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE c.id=p_contract_id AND c.organization_id=p_organization_id AND r.organization_id=p_organization_id AND b.organization_id=p_organization_id AND c.deleted_at IS NULL;
  PERFORM app_private.assert_meter_boundary_scope_v1(p_organization_id,v_building,'view');
  IF p_kind IS NULL OR p_kind NOT IN ('MOVE_OUT','MOVE_IN') THEN RAISE EXCEPTION 'Unknown boundary kind' USING ERRCODE='22023'; END IF;
  SELECT id INTO v_set FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind;
  RETURN app_private.meter_boundary_set_response_v1(v_set);
END $fn$;
CREATE OR REPLACE FUNCTION public.revise_contract_meter_boundary_set_v1(p_organization_id uuid,p_set_id uuid,p_expected_revision bigint,p_idempotency_key text,p_reason text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE;h app_private.contract_meter_boundary_history%ROWTYPE;v_hash text;v_ids uuid[];v_state text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong handover organization' USING ERRCODE='42501'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR p_idempotency_key IS NULL OR p_idempotency_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Correction needs a reason and request key' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE id=p_set_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Meter boundary not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_meter_boundary_writer_v1(s.organization_id,s.building_id);
  v_hash:=md5(jsonb_build_object('set_id',s.id,'expected_revision',p_expected_revision,'reason',btrim(p_reason),'payload',p_payload)::text);
  SELECT * INTO h FROM app_private.contract_meter_boundary_history WHERE set_id=s.id AND actor_id=auth.uid() AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF h.payload_hash<>v_hash THEN RAISE EXCEPTION 'Correction key reused with different facts' USING ERRCODE='23505'; END IF;
    RETURN app_private.meter_boundary_set_response_v1(s.id);
  END IF;
  IF p_expected_revision IS NULL OR s.revision<>p_expected_revision THEN RAISE EXCEPTION 'Meter boundary changed; reload' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.validate_meter_boundary_payload_v1(s.organization_id,s.room_id,s.building_id,p_payload);
  SELECT COALESCE(array_agg(DISTINCT x.id ORDER BY x.id),ARRAY[]::uuid[]) INTO v_ids FROM (
    SELECT id FROM public.invoices WHERE organization_id=s.organization_id AND contract_id=s.contract_id AND deleted_at IS NULL AND billing_month>=to_char(s.effective_on,'YYYY-MM')
      AND (approved_at IS NOT NULL OR status::text IN ('APPROVED','OVERDUE','PARTIAL_PAID','PAID','ISSUED'))
    UNION SELECT unnest(s.affected_invoice_ids)) x;
  v_state:=CASE WHEN cardinality(v_ids)>0 OR s.state='REVIEW' THEN 'REVIEW' ELSE p_payload->>'state' END;
  INSERT INTO app_private.contract_meter_boundary_history(set_id,revision,actor_id,reason,idempotency_key,payload_hash,before_snapshot,requested_payload)
    VALUES(s.id,s.revision+1,auth.uid(),btrim(p_reason),p_idempotency_key,v_hash,app_private.meter_boundary_set_response_v1(s.id),p_payload);
  UPDATE public.contract_meter_boundary_sets SET revision=revision+1,state=v_state,reason=CASE WHEN v_state='VERIFIED' THEN NULL ELSE btrim(p_reason) END,
    affected_invoice_ids=v_ids,updated_at=clock_timestamp() WHERE id=s.id;
  PERFORM app_private.insert_meter_boundary_revision_v1(s.id,p_payload);
  RETURN app_private.meter_boundary_set_response_v1(s.id);
END $fn$;
CREATE OR REPLACE FUNCTION public.read_contract_meter_interval_v1(p_organization_id uuid,p_contract_id uuid,p_meter_id uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE;v_exit public.contract_meter_boundary_sets%ROWTYPE;v_start public.contract_meter_boundaries%ROWTYPE;v_end public.contract_meter_boundaries%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind='MOVE_IN';
  PERFORM app_private.assert_meter_boundary_scope_v1(p_organization_id,s.building_id,'view');
  SELECT * INTO v_start FROM public.contract_meter_boundaries WHERE set_id=s.id AND revision=s.revision AND meter_id=p_meter_id;
  IF s.state IS DISTINCT FROM 'VERIFIED' OR v_start.state IS DISTINCT FROM 'VERIFIED' OR p_at IS NULL OR p_at<v_start.measured_at THEN
    RAISE EXCEPTION 'No verified own incoming predecessor for this interval' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_exit FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind='MOVE_OUT';
  IF (v_exit.id IS NOT NULL AND v_exit.state<>'VERIFIED') OR (v_exit.id IS NULL AND EXISTS(SELECT 1 FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND status='TERMINATED')) THEN
    RAISE EXCEPTION 'Outgoing residence boundary is missing or requires review' USING ERRCODE='55000'; END IF;
  SELECT b.* INTO v_end FROM public.contract_meter_boundaries b JOIN public.contract_meter_boundary_sets e ON e.id=b.set_id
    WHERE e.organization_id=p_organization_id AND e.contract_id=p_contract_id AND e.kind='MOVE_OUT' AND e.state='VERIFIED'
      AND b.revision=e.revision AND b.meter_id=p_meter_id AND b.state='VERIFIED';
  IF (v_exit.id IS NOT NULL AND v_end.id IS NULL) OR (v_end.id IS NOT NULL AND (v_end.measured_at<v_start.measured_at OR v_end.reading<v_start.reading OR p_at>v_end.measured_at)) THEN
    RAISE EXCEPTION 'Reading is outside the verified residence interval' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('contract_id',p_contract_id,'meter_id',p_meter_id,'state','VERIFIED','predecessor',jsonb_build_object('id',v_start.id,'kind','MOVE_IN','reading',v_start.reading,'measured_at',v_start.measured_at),
    'end',CASE WHEN v_end.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_end.id,'kind','MOVE_OUT','reading',v_end.reading,'measured_at',v_end.measured_at) END);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.guard_meter_boundary_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF TG_TABLE_NAME<>'contract_meter_boundary_sets' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Physical meter history is append-only' USING ERRCODE='42501'; END IF;
  IF (to_jsonb(NEW)-ARRAY['revision','state','reason','affected_invoice_ids','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','reason','affected_invoice_ids','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM app_private.contract_meter_boundary_history h WHERE h.set_id=OLD.id AND h.revision=NEW.revision AND h.actor_id=auth.uid()) THEN
    RAISE EXCEPTION 'Physical meter correction requires immutable subject and history' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS guard_meter_boundary_set_history ON public.contract_meter_boundary_sets;
CREATE TRIGGER guard_meter_boundary_set_history BEFORE UPDATE OR DELETE ON public.contract_meter_boundary_sets FOR EACH ROW EXECUTE FUNCTION app_private.guard_meter_boundary_immutable_v1();
DROP TRIGGER IF EXISTS guard_meter_boundary_facts ON public.contract_meter_boundaries;
CREATE TRIGGER guard_meter_boundary_facts BEFORE UPDATE OR DELETE ON public.contract_meter_boundaries FOR EACH ROW EXECUTE FUNCTION app_private.guard_meter_boundary_immutable_v1();
DROP TRIGGER IF EXISTS guard_meter_boundary_history ON app_private.contract_meter_boundary_history;
CREATE TRIGGER guard_meter_boundary_history BEFORE UPDATE OR DELETE ON app_private.contract_meter_boundary_history FOR EACH ROW EXECUTE FUNCTION app_private.guard_meter_boundary_immutable_v1();
CREATE OR REPLACE FUNCTION app_private.guard_meter_reading_boundary_ref_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.boundary_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contract_meter_boundaries b WHERE b.id=NEW.boundary_id AND b.organization_id=NEW.organization_id
    AND b.contract_id=NEW.contract_id AND b.room_id=NEW.room_id AND b.building_id=NEW.building_id AND b.meter_id=NEW.meter_id) THEN
    RAISE EXCEPTION 'Monthly reading boundary subject mismatch' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS guard_meter_reading_boundary_ref ON public.meter_readings;
CREATE TRIGGER guard_meter_reading_boundary_ref BEFORE INSERT OR UPDATE OF boundary_id,organization_id,contract_id,room_id,building_id,meter_id ON public.meter_readings
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_meter_reading_boundary_ref_v1();

REVOKE ALL ON FUNCTION app_private.assert_meter_boundary_scope_v1(uuid,uuid,text),app_private.assert_meter_boundary_writer_v1(uuid,uuid,text),
  app_private.meter_boundary_set_response_v1(uuid),app_private.validate_meter_boundary_payload_v1(uuid,uuid,uuid,jsonb),
  app_private.insert_meter_boundary_revision_v1(uuid,jsonb),app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text),
  app_private.assert_contract_move_in_boundaries_v1(uuid,uuid,text),app_private.guard_meter_boundary_immutable_v1(),app_private.guard_meter_reading_boundary_ref_v1()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_contract_meter_boundary_set_v1(uuid,uuid,text),public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb),
  public.read_contract_meter_interval_v1(uuid,uuid,uuid,timestamptz) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_meter_boundary_set_v1(uuid,uuid,text),public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb),
  public.read_contract_meter_interval_v1(uuid,uuid,uuid,timestamptz) TO authenticated;
NOTIFY pgrst,'reload schema';
