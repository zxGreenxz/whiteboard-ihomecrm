-- Actual return and pending old-contract settlement. Money engines and their
-- authorizers/accounting helpers stay unchanged apart from the two narrow seams.

CREATE TABLE IF NOT EXISTS public.contract_exit_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL UNIQUE,
  room_at_handover_id uuid NOT NULL,
  actual_move_out_on date NOT NULL,
  initial_kind text NOT NULL CHECK (initial_kind IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')),
  current_kind text NOT NULL CHECK (current_kind IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')),
  settlement_mode text NOT NULL CHECK (settlement_mode IN ('DEFERRED','IMMEDIATE')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','FINALIZED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  party_snapshot jsonb NOT NULL,
  contract_number text, building_name text, room_name text, customer_name text,
  physical_actor uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  physical_idempotency_key text NOT NULL,
  physical_payload_hash text NOT NULL,
  settlement_actor uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  settlement_idempotency_key text,
  settlement_payload_hash text,
  settlement_result jsonb,
  legacy_termination_id uuid UNIQUE REFERENCES public.contract_terminations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  FOREIGN KEY (organization_id,contract_id) REFERENCES public.contracts(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,room_at_handover_id) REFERENCES public.rooms(organization_id,id) ON DELETE RESTRICT,
  UNIQUE (organization_id,physical_actor,physical_idempotency_key),
  CHECK (physical_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  CHECK ((state='PENDING' AND settlement_result IS NULL AND legacy_termination_id IS NULL AND finalized_at IS NULL)
    OR (state='FINALIZED' AND settlement_result IS NOT NULL AND legacy_termination_id IS NOT NULL
      AND settlement_actor IS NOT NULL AND settlement_idempotency_key IS NOT NULL AND settlement_payload_hash IS NOT NULL AND finalized_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS contract_exit_cases_pending_building_idx
  ON public.contract_exit_cases(organization_id,building_id,actual_move_out_on,id) WHERE state='PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS contract_exit_cases_settlement_key_uq
  ON public.contract_exit_cases(organization_id,settlement_actor,settlement_idempotency_key) WHERE settlement_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_private.contract_exit_kind_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.contract_exit_cases(id) ON DELETE RESTRICT,
  before_kind text NOT NULL, after_kind text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>0),
  version bigint NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, payload_hash text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(case_id,version), UNIQUE(case_id,actor_id,idempotency_key)
);
-- Short-lived issuer context, not an operation store. Never exposed to callers.
CREATE TABLE IF NOT EXISTS app_private.contract_exit_writer_context (
  transaction_id bigint NOT NULL, backend_pid integer NOT NULL,
  case_id uuid NOT NULL REFERENCES public.contract_exit_cases(id) ON DELETE RESTRICT,
  case_version bigint NOT NULL, actor_id uuid NOT NULL, skip_physical boolean NOT NULL,
  PRIMARY KEY(transaction_id,backend_pid)
);
REVOKE ALL ON public.contract_exit_cases FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON app_private.contract_exit_kind_history,app_private.contract_exit_writer_context FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.contract_exit_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_exit_cases_scope_select ON public.contract_exit_cases;
CREATE POLICY contract_exit_cases_scope_select ON public.contract_exit_cases FOR SELECT TO authenticated
  USING (organization_id=ANY(public.my_org_ids()) AND public.can_access_building(building_id)
    AND public.can_do_on_building('contracts','view',building_id));
DROP POLICY IF EXISTS contract_exit_cases_hide_sandbox_admin ON public.contract_exit_cases;
CREATE POLICY contract_exit_cases_hide_sandbox_admin ON public.contract_exit_cases AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION app_private.guard_contract_exit_case_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Exit cases cannot be deleted' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id JOIN public.buildings b ON b.id=r.building_id
      WHERE c.id=NEW.contract_id AND c.organization_id=NEW.organization_id AND r.organization_id=NEW.organization_id
      AND b.organization_id=NEW.organization_id AND r.id=NEW.room_at_handover_id AND b.id=NEW.building_id) THEN
      RAISE EXCEPTION 'Exit subject scope mismatch' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['current_kind','state','version','updated_at','settlement_actor','settlement_idempotency_key','settlement_payload_hash','settlement_result','legacy_termination_id','finalized_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_kind','state','version','updated_at','settlement_actor','settlement_idempotency_key','settlement_payload_hash','settlement_result','legacy_termination_id','finalized_at']) THEN
    RAISE EXCEPTION 'Physical exit facts are immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.state='FINALIZED' THEN RAISE EXCEPTION 'Exit settlement is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid exit version' USING ERRCODE='PT409'; END IF;
  IF NEW.current_kind IS DISTINCT FROM OLD.current_kind AND NOT EXISTS (
    SELECT 1 FROM app_private.contract_exit_kind_history h WHERE h.case_id=OLD.id AND h.version=NEW.version
      AND h.before_kind=OLD.current_kind AND h.after_kind=NEW.current_kind AND h.actor_id=auth.uid()) THEN
    RAISE EXCEPTION 'Kind change requires history' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS guard_contract_exit_case ON public.contract_exit_cases;
CREATE TRIGGER guard_contract_exit_case BEFORE INSERT OR UPDATE OR DELETE ON public.contract_exit_cases
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_exit_case_v1();

CREATE OR REPLACE FUNCTION app_private.guard_contract_exit_history_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'Exit kind history is append-only' USING ERRCODE='42501'; END $fn$;
DROP TRIGGER IF EXISTS guard_contract_exit_history ON app_private.contract_exit_kind_history;
CREATE TRIGGER guard_contract_exit_history BEFORE UPDATE OR DELETE ON app_private.contract_exit_kind_history
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_exit_history_v1();

CREATE OR REPLACE FUNCTION app_private.assert_contract_exit_scope_v1(p_org uuid,p_building uuid,p_action text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false)
    OR NOT COALESCE(public.can_access_building(p_building),false)
    OR NOT COALESCE(public.can_do_on_building('contracts',p_action,p_building),false) THEN
    RAISE EXCEPTION 'Missing permission for exit case' USING ERRCODE='42501';
  END IF;
  IF p_action='view' AND public.is_super_admin() AND COALESCE(p_org=ANY(public.sandbox_org_ids()),false) THEN
    RAISE EXCEPTION 'Exit case is outside the readable scope' USING ERRCODE='42501';
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.assert_contract_exit_writer_v1(p_org uuid,p_building uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean;
BEGIN
  PERFORM app_private.assert_contract_exit_scope_v1(p_org,p_building,'edit');
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',p_building,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Missing contracts.edit permission' USING ERRCODE='42501'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.contract_exit_case_response_v1(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('id',c.id,'organization_id',c.organization_id,'building_id',c.building_id,
    'contract_id',c.contract_id,'room_at_handover_id',c.room_at_handover_id,'actual_move_out_on',c.actual_move_out_on,
    'initial_kind',c.initial_kind,'current_kind',c.current_kind,'settlement_mode',c.settlement_mode,'state',c.state,
    'version',c.version,'created_at',c.created_at,'updated_at',c.updated_at,'contract_number',c.contract_number,
    'building_name',c.building_name,'room_name',c.room_name,'customer_name',c.customer_name,
    'settlement_result',CASE WHEN public.can_do_on_building('contracts','edit',c.building_id) THEN c.settlement_result ELSE NULL END,
    'kind_history',COALESCE((SELECT jsonb_agg(jsonb_build_object('before_kind',h.before_kind,'after_kind',h.after_kind,
      'reason',h.reason,'version',h.version,'changed_at',h.changed_at,'changed_by',h.actor_id,
      'actor_name',(SELECT p.full_name FROM public.profiles p WHERE p.id=h.actor_id)) ORDER BY h.version) FROM app_private.contract_exit_kind_history h WHERE h.case_id=c.id),'[]'::jsonb))
  FROM public.contract_exit_cases c WHERE c.id=p_case
$fn$;

CREATE OR REPLACE FUNCTION app_private.is_contract_exit_settlement_v1(p_contract uuid,p_date date)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT EXISTS(SELECT 1 FROM app_private.contract_exit_writer_context x JOIN public.contract_exit_cases c ON c.id=x.case_id
    WHERE x.transaction_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.actor_id=auth.uid()
      AND x.skip_physical AND x.case_version=c.version AND c.state='PENDING'
      AND c.contract_id=p_contract AND c.actual_move_out_on=p_date)
$fn$;

CREATE OR REPLACE FUNCTION app_private.run_contract_exit_settlement_v1(p_case uuid,p_kind text,p_payload jsonb,p_key text,p_skip_physical boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contract_exit_cases%ROWTYPE; v_result jsonb; v_inner_key text; v_allowed text[];
BEGIN
  SELECT * INTO STRICT c FROM public.contract_exit_cases WHERE id=p_case;
  PERFORM app_private.assert_contract_exit_writer_v1(c.organization_id,c.building_id);
  IF p_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT') OR p_kind IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid settlement branch' USING ERRCODE='22023';
  END IF;
  v_allowed:=CASE WHEN p_kind='FORFEIT' THEN ARRAY['extra_charges'] ELSE ARRAY['deposit_refund','penalty_fee','excess_rent','outstanding_debt','notes','extra_charges','shortfall_mode','receipt_account_id','refund_items'] END;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT k=ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Unknown settlement fields' USING ERRCODE='22023';
  END IF;
  -- Bind the old canonical key to this exact case/actor request; old money hash
  -- and old monetary policy are still enforced by the unchanged wrapper.
  v_inner_key:='exit-settle:'||c.id::text||':'||md5(p_key);
  INSERT INTO app_private.contract_exit_writer_context(transaction_id,backend_pid,case_id,case_version,actor_id,skip_physical)
    VALUES(txid_current(),pg_backend_pid(),c.id,c.version,auth.uid(),p_skip_physical);
  BEGIN
    IF p_kind='FORFEIT' THEN
      v_result:=public.terminate_contract_forfeit_with_credit_v1(c.contract_id,c.actual_move_out_on,COALESCE(p_payload->'extra_charges','[]'::jsonb),v_inner_key);
    ELSE
      v_result:=public.terminate_contract_move_out_with_credit_v1(c.contract_id,c.actual_move_out_on,
        COALESCE((p_payload->>'deposit_refund')::numeric,0),COALESCE((p_payload->>'penalty_fee')::numeric,0),
        COALESCE((p_payload->>'excess_rent')::numeric,0),COALESCE((p_payload->>'outstanding_debt')::numeric,0),
        p_payload->>'notes',COALESCE(p_payload->'extra_charges','[]'::jsonb),COALESCE(p_payload->>'shortfall_mode','PAID'),
        NULLIF(p_payload->>'receipt_account_id','')::uuid,v_inner_key,COALESCE(p_payload->'refund_items','[]'::jsonb));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.contract_exit_writer_context WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
    RAISE;
  END;
  DELETE FROM app_private.contract_exit_writer_context WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN v_result;
END $fn$;

-- Retire the old shape so PostgREST never sees ambiguous defaulted overloads.
-- The meter migration must be installed before executing this handover RPC.
DROP FUNCTION IF EXISTS public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb);
CREATE OR REPLACE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid,p_contract_id uuid,p_expected_contract_updated_at timestamptz,p_idempotency_key text,
  p_actual_move_out_on date,p_initial_kind text,p_settlement_mode text,p_settlement jsonb DEFAULT NULL,p_meter_boundary jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE; v_room public.rooms%ROWTYPE; v_building public.buildings%ROWTYPE;
  e public.contract_exit_cases%ROWTYPE; v_key text:=btrim(p_idempotency_key); v_hash text; v_result jsonb; v_legacy uuid; v_party jsonb; v_customer text;
BEGIN
  IF p_actual_move_out_on IS NULL OR p_initial_kind IS NULL OR p_initial_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')
    OR p_settlement_mode IS NULL OR p_settlement_mode NOT IN ('DEFERRED','IMMEDIATE') OR v_key IS NULL
    OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Actual date, initial kind, mode and request key are required' USING ERRCODE='22023'; END IF;
  IF (p_settlement_mode='DEFERRED' AND p_settlement IS NOT NULL) OR (p_settlement_mode='IMMEDIATE' AND jsonb_typeof(p_settlement) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'Settlement payload does not match return mode' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
  SELECT * INTO v_building FROM public.buildings WHERE id=v_room.building_id;
  IF v_room.organization_id IS DISTINCT FROM c.organization_id OR v_building.organization_id IS DISTINCT FROM c.organization_id THEN
    RAISE EXCEPTION 'Contract room scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(c.organization_id,v_room.building_id);
  v_hash:=md5(jsonb_build_object('contract_id',p_contract_id,'expected_updated_at',p_expected_contract_updated_at,'actual_date',p_actual_move_out_on,
    'initial_kind',p_initial_kind,'mode',p_settlement_mode,'settlement',p_settlement,'meter_boundary',p_meter_boundary)::text);
  SELECT * INTO e FROM public.contract_exit_cases WHERE contract_id=p_contract_id FOR UPDATE;
  IF FOUND THEN
    IF e.physical_actor=auth.uid() AND e.physical_idempotency_key=v_key THEN
      IF e.physical_payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different return intent' USING ERRCODE='23505'; END IF;
      RETURN app_private.contract_exit_case_response_v1(e.id);
    END IF;
    RAISE EXCEPTION 'Contract has already been physically returned' USING ERRCODE='PT409';
  END IF;
  IF p_expected_contract_updated_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_contract_updated_at THEN
    RAISE EXCEPTION 'Contract changed; reload before returning' USING ERRCODE='PT409'; END IF;
  IF p_actual_move_out_on>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Actual return date cannot be in the future; use a planned notice' USING ERRCODE='22023'; END IF;
  IF c.status NOT IN ('ACTIVE','EXTENDED') OR c.room_id IS NULL OR c.actual_end_date IS NOT NULL OR p_actual_move_out_on<c.start_date
    OR EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id) THEN
    RAISE EXCEPTION 'Contract is not eligible for an actual return' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id AND cu.organization_id IS DISTINCT FROM c.organization_id) THEN
    RAISE EXCEPTION 'Party scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('tenant_id',c.tenant_id,'parent_contract_id',c.parent_contract_id,
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative) ORDER BY cc.customer_id)
      FROM public.contract_customers cc WHERE cc.contract_id=c.id),'[]'::jsonb),
    'tenants',COALESCE((SELECT jsonb_agg(ct.tenant_id ORDER BY ct.tenant_id) FROM public.contract_tenants ct WHERE ct.contract_id=c.id),'[]'::jsonb)) INTO v_party;
  SELECT cu.full_name INTO v_customer FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.customer_id LIMIT 1;
  INSERT INTO public.contract_exit_cases(organization_id,building_id,contract_id,room_at_handover_id,actual_move_out_on,initial_kind,current_kind,
    settlement_mode,party_snapshot,physical_actor,physical_idempotency_key,physical_payload_hash,contract_number,building_name,room_name,customer_name)
    VALUES(c.organization_id,v_room.building_id,c.id,c.room_id,p_actual_move_out_on,p_initial_kind,p_initial_kind,
      p_settlement_mode,v_party,auth.uid(),v_key,v_hash,c.contract_number,v_building.name,v_room.name,v_customer) RETURNING * INTO e;
  -- Pass listings belong to the departing occupancy. A retry exits above, so it
  -- cannot retire a listing created for the next tenant after this handover.
  UPDATE public.room_pass_listings SET active=false,updated_at=clock_timestamp()
    WHERE room_id=c.room_id AND active
      AND (organization_id=c.organization_id OR (organization_id IS NULL AND user_id=c.user_id));
  IF p_settlement_mode='DEFERRED' THEN
    -- Absolutely no call to a financial/termination writer in this branch.
    UPDATE public.contracts SET status='TERMINATED',actual_end_date=p_actual_move_out_on,updated_at=clock_timestamp() WHERE id=c.id;
  ELSE
    v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_initial_kind,p_settlement,v_key,false);
    SELECT id INTO v_legacy FROM public.contract_terminations WHERE contract_id=c.id AND actual_move_out_date=p_actual_move_out_on AND status='COMPLETED';
    IF v_legacy IS NULL THEN RAISE EXCEPTION 'Settlement did not record its financial audit' USING ERRCODE='55000'; END IF;
    UPDATE public.contract_exit_cases SET state='FINALIZED',version=version+1,updated_at=clock_timestamp(),finalized_at=clock_timestamp(),
      settlement_actor=auth.uid(),settlement_idempotency_key=v_key,settlement_payload_hash=v_hash,settlement_result=v_result,legacy_termination_id=v_legacy WHERE id=e.id;
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(c.organization_id,c.id,c.room_id,'MOVE_OUT',p_actual_move_out_on,
    COALESCE(p_meter_boundary,jsonb_build_object('state','MISSING','reason','Chưa ghi chỉ số khi trả phòng','readings','[]'::jsonb)));
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $fn$;

CREATE OR REPLACE FUNCTION public.finalize_contract_exit_case_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_idempotency_key text,
  p_current_kind text,p_reason text,p_settlement jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; c public.contracts%ROWTYPE; v_contract uuid; v_key text:=btrim(p_idempotency_key); v_hash text; v_result jsonb; v_legacy uuid;
BEGIN
  IF v_key IS NULL OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR p_current_kind IS NULL
    OR p_current_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT') THEN RAISE EXCEPTION 'Invalid settlement request' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT contract_id INTO v_contract FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id;
  SELECT * INTO c FROM public.contracts WHERE id=v_contract AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF e.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  v_hash:=md5(jsonb_build_object('case_id',e.id,'expected_version',p_expected_version,'current_kind',p_current_kind,'reason',p_reason,'settlement',p_settlement)::text);
  IF e.state='FINALIZED' THEN
    IF e.settlement_actor=auth.uid() AND e.settlement_idempotency_key=v_key THEN
      IF e.settlement_payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different settlement intent' USING ERRCODE='23505'; END IF;
      RETURN app_private.contract_exit_case_response_v1(e.id);
    END IF;
    RAISE EXCEPTION 'Exit case is already finalized' USING ERRCODE='PT409';
  END IF;
  IF p_expected_version IS NULL OR e.version<>p_expected_version THEN RAISE EXCEPTION 'Exit case changed; reload' USING ERRCODE='PT409'; END IF;
  IF c.status<>'TERMINATED' OR c.organization_id IS DISTINCT FROM e.organization_id OR c.room_id IS DISTINCT FROM e.room_at_handover_id
    OR c.actual_end_date IS DISTINCT FROM e.actual_move_out_on THEN RAISE EXCEPTION 'Physical exit identity changed' USING ERRCODE='55000'; END IF;
  IF e.current_kind IS DISTINCT FROM p_current_kind AND NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'A kind change requires a reason' USING ERRCODE='22023'; END IF;
  -- Same contract, same pinned party. Never authorize a current occupant by room.
  IF e.party_snapshot IS DISTINCT FROM jsonb_build_object('tenant_id',c.tenant_id,'parent_contract_id',c.parent_contract_id,
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative) ORDER BY cc.customer_id)
      FROM public.contract_customers cc WHERE cc.contract_id=c.id),'[]'::jsonb),
    'tenants',COALESCE((SELECT jsonb_agg(ct.tenant_id ORDER BY ct.tenant_id) FROM public.contract_tenants ct WHERE ct.contract_id=c.id),'[]'::jsonb)) THEN
    RAISE EXCEPTION 'Exit party lineage needs review' USING ERRCODE='55000'; END IF;
  v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_current_kind,p_settlement,v_key,true);
  SELECT id INTO v_legacy FROM public.contract_terminations WHERE contract_id=c.id AND actual_move_out_date=e.actual_move_out_on AND status='COMPLETED';
  IF v_legacy IS NULL THEN RAISE EXCEPTION 'Settlement did not record its financial audit' USING ERRCODE='55000'; END IF;
  IF e.current_kind IS DISTINCT FROM p_current_kind THEN
    INSERT INTO app_private.contract_exit_kind_history(case_id,before_kind,after_kind,reason,version,actor_id,idempotency_key,payload_hash)
      VALUES(e.id,e.current_kind,p_current_kind,btrim(p_reason),e.version+1,auth.uid(),v_key,v_hash);
  END IF;
  UPDATE public.contract_exit_cases SET current_kind=p_current_kind,state='FINALIZED',version=version+1,updated_at=clock_timestamp(),finalized_at=clock_timestamp(),
    settlement_actor=auth.uid(),settlement_idempotency_key=v_key,settlement_payload_hash=v_hash,settlement_result=v_result,legacy_termination_id=v_legacy WHERE id=e.id;
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $fn$;

CREATE OR REPLACE FUNCTION public.update_contract_exit_case_kind_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_kind text,p_reason text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; h app_private.contract_exit_kind_history%ROWTYPE; v_key text:=btrim(p_idempotency_key); v_hash text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT') OR NULLIF(btrim(p_reason),'') IS NULL
    OR v_key IS NULL OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Kind, reason and request key are required' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  v_hash:=md5(jsonb_build_object('case_id',p_case_id,'expected_version',p_expected_version,'kind',p_kind,'reason',btrim(p_reason))::text);
  SELECT * INTO h FROM app_private.contract_exit_kind_history WHERE case_id=e.id AND actor_id=auth.uid() AND idempotency_key=v_key;
  IF FOUND THEN
    IF h.payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different kind change' USING ERRCODE='23505'; END IF;
    RETURN app_private.contract_exit_case_response_v1(e.id);
  END IF;
  IF p_expected_version IS NULL OR e.version<>p_expected_version OR e.state<>'PENDING' THEN RAISE EXCEPTION 'Exit case changed or finalized' USING ERRCODE='PT409'; END IF;
  INSERT INTO app_private.contract_exit_kind_history(case_id,before_kind,after_kind,reason,version,actor_id,idempotency_key,payload_hash)
    VALUES(e.id,e.current_kind,p_kind,btrim(p_reason),e.version+1,auth.uid(),v_key,v_hash);
  UPDATE public.contract_exit_cases SET current_kind=p_kind,version=version+1,updated_at=clock_timestamp() WHERE id=e.id;
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $fn$;

CREATE OR REPLACE FUNCTION public.get_contract_exit_case_v1(p_organization_id uuid,p_case_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_scope_v1(e.organization_id,e.building_id,'view');
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $fn$;

CREATE OR REPLACE FUNCTION public.list_contract_exit_cases_v1(p_organization_id uuid,p_building_id uuid DEFAULT NULL,p_state text DEFAULT NULL,
  p_limit integer DEFAULT 50,p_offset integer DEFAULT 0,p_contract_id uuid DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_total bigint; v_items jsonb; v_org uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the readable scope' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_offset IS NULL OR p_offset<0 OR (p_state IS NOT NULL AND p_state NOT IN ('PENDING','FINALIZED')) THEN
    RAISE EXCEPTION 'Invalid exit case pagination/filter' USING ERRCODE='22023'; END IF;
  IF p_building_id IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.buildings WHERE id=p_building_id;
    IF v_org IS DISTINCT FROM p_organization_id THEN RAISE EXCEPTION 'Building organization mismatch' USING ERRCODE='42501'; END IF;
    PERFORM app_private.assert_contract_exit_scope_v1(v_org,p_building_id,'view');
  END IF;
  SELECT count(*) INTO v_total FROM public.contract_exit_cases c
    WHERE c.organization_id=p_organization_id AND public.can_access_building(c.building_id)
      AND public.can_do_on_building('contracts','view',c.building_id)
      AND NOT (public.is_super_admin() AND COALESCE(c.organization_id=ANY(public.sandbox_org_ids()),false))
      AND (p_building_id IS NULL OR c.building_id=p_building_id) AND (p_state IS NULL OR c.state=p_state)
      AND (p_contract_id IS NULL OR c.contract_id=p_contract_id) AND (p_building_ids IS NULL OR c.building_id=ANY(p_building_ids));
  SELECT COALESCE(jsonb_agg(app_private.contract_exit_case_response_v1(q.id) ORDER BY q.actual_move_out_on,q.id),'[]'::jsonb) INTO v_items
    FROM (SELECT c.id,c.actual_move_out_on FROM public.contract_exit_cases c
      WHERE c.organization_id=p_organization_id AND public.can_access_building(c.building_id)
        AND public.can_do_on_building('contracts','view',c.building_id)
        AND NOT (public.is_super_admin() AND COALESCE(c.organization_id=ANY(public.sandbox_org_ids()),false))
        AND (p_building_id IS NULL OR c.building_id=p_building_id) AND (p_state IS NULL OR c.state=p_state)
        AND (p_contract_id IS NULL OR c.contract_id=p_contract_id) AND (p_building_ids IS NULL OR c.building_id=ANY(p_building_ids))
      ORDER BY c.actual_move_out_on,c.id LIMIT p_limit OFFSET p_offset) q;
  RETURN jsonb_build_object('items',v_items,'total',v_total,'limit',p_limit,'offset',p_offset,
    'server_today',public.org_today_v1(p_organization_id),'server_now',clock_timestamp());
END $fn$;

-- Forward supersession: patch ONLY each impl's terminated eligibility guard and
-- physical UPDATE. No financial helper, period mutex, approval or ledger patch.
DO $patch$
DECLARE v_sig text; v_date text; d text; v_guard text; v_update text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.terminate_contract_forfeit_impl(uuid,date,jsonb)',
    'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN RAISE EXCEPTION 'Required current termination impl missing: %',v_sig; END IF;
    d:=pg_get_functiondef(v_sig::regprocedure);
    IF position('app_private.is_contract_exit_settlement_v1(' IN d)>0 THEN CONTINUE; END IF;
    v_date:=CASE WHEN v_sig LIKE '%forfeit%' THEN 'p_forfeit_date' ELSE 'p_move_out_date' END;
    v_guard:=substring(d FROM $rx$(?s)IF v_contract[.]status IN [(]'TERMINATED','EXPIRED'[)] THEN.*?END IF;$rx$);
    v_update:=substring(d FROM $rx$(?s)  UPDATE contracts\s+SET status\s*=\s*'TERMINATED'.*?WHERE id = p_contract_id;$rx$);
    IF v_guard IS NULL OR v_update IS NULL THEN RAISE EXCEPTION 'Termination seam shape changed; review % before patching',v_sig; END IF;
    d:=replace(d,v_guard,replace(v_guard,' THEN',' AND NOT (v_contract.status = ''TERMINATED'' AND app_private.is_contract_exit_settlement_v1(p_contract_id,'||v_date||')) THEN'));
    d:=replace(d,v_update,'  IF NOT app_private.is_contract_exit_settlement_v1(p_contract_id,'||v_date||') THEN'||E'\n'||v_update||E'\n  END IF;');
    EXECUTE d;
  END LOOP;
END $patch$;

REVOKE ALL ON FUNCTION app_private.guard_contract_exit_case_v1(),app_private.guard_contract_exit_history_v1(),
  app_private.assert_contract_exit_scope_v1(uuid,uuid,text),app_private.contract_exit_case_response_v1(uuid),
  app_private.assert_contract_exit_writer_v1(uuid,uuid),
  app_private.is_contract_exit_settlement_v1(uuid,date),app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb),
  public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb),public.update_contract_exit_case_kind_v1(uuid,uuid,bigint,text,text,text),
  public.get_contract_exit_case_v1(uuid,uuid),public.list_contract_exit_cases_v1(uuid,uuid,text,integer,integer,uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb),
  public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb),public.update_contract_exit_case_kind_v1(uuid,uuid,bigint,text,text,text),
  public.get_contract_exit_case_v1(uuid,uuid),public.list_contract_exit_cases_v1(uuid,uuid,text,integer,integer,uuid,uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
