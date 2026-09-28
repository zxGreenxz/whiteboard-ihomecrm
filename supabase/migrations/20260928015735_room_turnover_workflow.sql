-- Operational turnover tracking only: no occupancy, jobs/payroll or financial effects.
CREATE TABLE IF NOT EXISTS public.room_turnovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL UNIQUE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  source_contract_id uuid REFERENCES public.contracts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PENDING','READY')),
  expected_ready_on date,
  responsible_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,room_id) REFERENCES public.rooms(organization_id,id) ON DELETE RESTRICT,
  CHECK (expected_ready_on IS NULL OR (isfinite(expected_ready_on) AND expected_ready_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'))
);
CREATE TABLE IF NOT EXISTS public.room_turnover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  turnover_id uuid NOT NULL,
  room_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  version bigint NOT NULL CHECK (version > 0),
  actor_id uuid NOT NULL,
  previous_state jsonb,
  new_state jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id,turnover_id) REFERENCES public.room_turnovers(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,room_id) REFERENCES public.rooms(organization_id,id) ON DELETE RESTRICT,
  UNIQUE (turnover_id,version)
);
CREATE INDEX IF NOT EXISTS room_turnovers_queue_idx ON public.room_turnovers(organization_id,expected_ready_on,room_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS room_turnover_events_room_idx ON public.room_turnover_events(organization_id,room_id,version DESC);
ALTER TABLE public.room_turnovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_turnover_events ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['room_turnovers','room_turnover_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',v_table||'_select',v_table);
    EXECUTE format($policy$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
      organization_id=ANY(public.my_org_ids()) AND EXISTS (
        SELECT 1 FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
        WHERE r.id=%I.room_id AND r.organization_id=%I.organization_id
          AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND public.can_access_building(b.id)
          AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('rooms.view',r.organization_id) s
            WHERE s.org_wide OR b.id=ANY(s.building_ids))))$policy$,v_table||'_select',v_table,v_table,v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',v_table||'_hide_sandbox_admin',v_table);
    EXECUTE format($policy$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (NOT COALESCE(organization_id=ANY(public.sandbox_org_ids()),false) OR COALESCE(organization_id=ANY(public.my_org_ids()),false))
      WITH CHECK (NOT COALESCE(organization_id=ANY(public.sandbox_org_ids()),false) OR COALESCE(organization_id=ANY(public.my_org_ids()),false))$policy$,
      v_table||'_hide_sandbox_admin',v_table);
  END LOOP;
END;
$policies$;
REVOKE ALL ON public.room_turnovers,public.room_turnover_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.room_turnovers,public.room_turnover_events TO authenticated;

CREATE OR REPLACE FUNCTION public.read_room_turnover_v1(p_organization_id uuid,p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_room public.rooms%ROWTYPE;v_turnover public.room_turnovers%ROWTYPE;v_history jsonb;v_can_start boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Turnover organization unavailable' USING ERRCODE='42501';
  END IF;
  SELECT r.* INTO v_room FROM public.rooms r
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    JOIN public.organizations o ON o.id=r.organization_id AND o.status='ACTIVE'
    WHERE r.id=p_room_id AND r.organization_id=p_organization_id
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND public.can_access_building(b.id)
      AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('rooms.view',p_organization_id) s
        WHERE s.org_wide OR b.id=ANY(s.building_ids));
  IF NOT FOUND THEN RAISE EXCEPTION 'Turnover room unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO v_turnover FROM public.room_turnovers WHERE room_id=p_room_id AND organization_id=p_organization_id;
  v_can_start := (v_turnover.id IS NULL OR v_turnover.status='READY') AND v_room.status IN ('AVAILABLE','RESERVED') AND NOT EXISTS (
    SELECT 1 FROM public.contracts c WHERE c.room_id=p_room_id AND c.organization_id=p_organization_id
      AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL);
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.version DESC),'[]'::jsonb) INTO v_history FROM (
    SELECT id,epoch,actor_id,created_at,previous_state,new_state,reason,version
      FROM public.room_turnover_events WHERE room_id=p_room_id AND organization_id=p_organization_id
      ORDER BY version DESC LIMIT 20) e;
  RETURN jsonb_build_object('today',public.org_today_v1(p_organization_id),'can_start_new_cycle',v_can_start,
    'turnover',CASE WHEN v_turnover.id IS NULL THEN NULL ELSE to_jsonb(v_turnover) END,'history',v_history);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_room_turnover_v1(
  p_organization_id uuid,p_room_id uuid,p_expected_version bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE
  v_room public.rooms%ROWTYPE;v_turnover public.room_turnovers%ROWTYPE;v_previous jsonb;
  v_allowed boolean;v_new_cycle boolean;v_status text;v_date date;v_responsible uuid;v_source uuid;v_reason text;v_epoch integer;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Turnover organization unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT r.* INTO v_room FROM public.rooms r
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    JOIN public.organizations o ON o.id=r.organization_id AND o.status='ACTIVE'
    WHERE r.id=p_room_id AND r.organization_id=p_organization_id
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND public.can_access_building(b.id)
    FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Turnover room unavailable' USING ERRCODE='42501';END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
    auth.uid(),p_organization_id,'rooms.edit',v_room.building_id,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Not authorized to edit turnover' USING ERRCODE='42501';END IF;
  IF p_expected_version IS NULL OR p_expected_version<0 OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR NOT p_payload ?& ARRAY['status','expected_ready_on','responsible_user_id','source_contract_id','reason','start_new_cycle']
    OR (p_payload-ARRAY['status','expected_ready_on','responsible_user_id','source_contract_id','reason','start_new_cycle'])<>'{}'::jsonb
    OR jsonb_typeof(p_payload->'status') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'start_new_cycle') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_payload->'expected_ready_on') NOT IN ('string','null')
    OR jsonb_typeof(p_payload->'responsible_user_id') NOT IN ('string','null')
    OR jsonb_typeof(p_payload->'source_contract_id') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Invalid turnover payload' USING ERRCODE='22023';
  END IF;
  v_status:=p_payload->>'status';v_reason:=btrim(p_payload->>'reason');v_new_cycle:=(p_payload->>'start_new_cycle')::boolean;
  IF v_status NOT IN ('PENDING','READY') OR length(v_reason) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid turnover state or reason' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_date:=(p_payload->>'expected_ready_on')::date;v_responsible:=(p_payload->>'responsible_user_id')::uuid;v_source:=(p_payload->>'source_contract_id')::uuid;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid turnover date or user/source' USING ERRCODE='22023';
  END;
  IF v_date IS NOT NULL AND (NOT isfinite(v_date) OR (p_payload->>'expected_ready_on') !~ '^\d{4}-\d{2}-\d{2}$'
      OR v_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') THEN
    RAISE EXCEPTION 'Invalid turnover date' USING ERRCODE='22023';
  END IF;
  IF v_responsible IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_memberships m
    WHERE m.organization_id=p_organization_id AND m.user_id=v_responsible AND m.status='ACTIVE'
      AND m.valid_from<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp())) THEN
    RAISE EXCEPTION 'Turnover responsibility unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_turnover FROM public.room_turnovers WHERE room_id=p_room_id AND organization_id=p_organization_id FOR UPDATE;
  IF COALESCE(v_turnover.version,0)<>p_expected_version THEN RAISE EXCEPTION 'Turnover version changed; reload' USING ERRCODE='PT409';END IF;
  IF v_source IS NOT NULL AND (v_turnover.id IS NULL OR v_new_cycle) AND NOT EXISTS (SELECT 1 FROM public.contracts c
    WHERE c.id=v_source AND c.room_id=p_room_id AND c.organization_id=p_organization_id
      AND c.deleted_at IS NULL AND (c.status IN ('TERMINATED','TRANSFERRED') OR c.actual_end_date IS NOT NULL)) THEN
    RAISE EXCEPTION 'Turnover source unavailable' USING ERRCODE='42501';
  END IF;
  v_previous:=CASE WHEN v_turnover.id IS NULL THEN NULL ELSE to_jsonb(v_turnover) END;
  IF v_turnover.id IS NULL OR v_new_cycle THEN
    IF v_room.status NOT IN ('AVAILABLE','RESERVED') OR EXISTS (SELECT 1 FROM public.contracts c
      WHERE c.room_id=p_room_id AND c.organization_id=p_organization_id AND c.status='ACTIVE'
        AND c.actual_end_date IS NULL AND c.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Room is not physically vacant' USING ERRCODE='55000';
    END IF;
    IF v_turnover.id IS NOT NULL AND v_turnover.status<>'READY' THEN
      RAISE EXCEPTION 'Current turnover remains pending' USING ERRCODE='55000';
    END IF;
    v_epoch:=COALESCE(v_turnover.epoch,0)+1;
  ELSE
    IF v_turnover.source_contract_id IS DISTINCT FROM v_source THEN
      RAISE EXCEPTION 'Turnover source is immutable within this phase' USING ERRCODE='55000';
    END IF;
    v_epoch:=v_turnover.epoch;
  END IF;
  IF v_turnover.id IS NULL THEN
    INSERT INTO public.room_turnovers(organization_id,room_id,epoch,source_contract_id,status,expected_ready_on,responsible_user_id,reason,created_by,updated_by)
      VALUES(p_organization_id,p_room_id,v_epoch,v_source,v_status,v_date,v_responsible,v_reason,auth.uid(),auth.uid()) RETURNING * INTO v_turnover;
  ELSE
    UPDATE public.room_turnovers SET version=version+1,epoch=v_epoch,source_contract_id=v_source,status=v_status,
      expected_ready_on=v_date,responsible_user_id=v_responsible,reason=v_reason,updated_by=auth.uid(),updated_at=clock_timestamp()
      WHERE id=v_turnover.id RETURNING * INTO v_turnover;
  END IF;
  INSERT INTO public.room_turnover_events(organization_id,turnover_id,room_id,epoch,version,actor_id,previous_state,new_state,reason)
    VALUES(p_organization_id,v_turnover.id,p_room_id,v_turnover.epoch,v_turnover.version,auth.uid(),v_previous,to_jsonb(v_turnover),v_reason);
  -- The writer may be edit-only. Return its authorized result without requiring read capability.
  RETURN jsonb_build_object('today',public.org_today_v1(p_organization_id),'can_start_new_cycle',
    v_turnover.status='READY' AND v_room.status IN ('AVAILABLE','RESERVED') AND NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.room_id=p_room_id AND c.organization_id=p_organization_id AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL),
    'turnover',to_jsonb(v_turnover),'history','[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_room_turnover_queue_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 25,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_today date;v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Turnover organization unavailable' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset<0 THEN
    RAISE EXCEPTION 'Invalid turnover pagination' USING ERRCODE='22023';
  END IF;
  v_today:=public.org_today_v1(p_organization_id);
  WITH eligible AS MATERIALIZED (
    SELECT r.id AS room_id,r.name AS room_name,b.id AS building_id,b.name AS building_name,
      t.version,t.epoch,t.source_contract_id,t.expected_ready_on,t.responsible_user_id,t.status
    FROM public.room_turnovers t JOIN public.rooms r ON r.id=t.room_id AND r.organization_id=t.organization_id
      JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
      JOIN public.organizations o ON o.id=t.organization_id AND o.status='ACTIVE'
    WHERE t.organization_id=p_organization_id AND t.status='PENDING'
      AND (t.expected_ready_on IS NULL OR t.expected_ready_on<=v_today)
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids)) AND public.can_access_building(b.id)
      AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('rooms.view',p_organization_id) s
        WHERE s.org_wide OR b.id=ANY(s.building_ids))
  ),page AS (SELECT * FROM eligible ORDER BY expected_ready_on NULLS FIRST,room_id LIMIT p_limit OFFSET p_offset)
  SELECT jsonb_build_object('today',v_today,'total',(SELECT count(*) FROM eligible),'items',
    COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY expected_ready_on NULLS FIRST,room_id) FROM page),'[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.read_room_turnover_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.save_room_turnover_v1(uuid,uuid,bigint,jsonb) OWNER TO postgres;
ALTER FUNCTION public.list_room_turnover_queue_v1(uuid,uuid[],integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_room_turnover_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_room_turnover_v1(uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.list_room_turnover_queue_v1(uuid,uuid[],integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_room_turnover_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_room_turnover_v1(uuid,uuid,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_room_turnover_queue_v1(uuid,uuid[],integer,integer) TO authenticated;
