-- A notice is an expected civil date only. It never settles money or frees a room.

CREATE TABLE IF NOT EXISTS public.contract_move_out_notice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  previous_date date,
  new_date date,
  reason text,
  contract_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contract_move_out_notice_events_reason_length CHECK (length(reason) <= 2000),
  CONSTRAINT contract_move_out_notice_events_changed CHECK (previous_date IS DISTINCT FROM new_date)
);
CREATE INDEX IF NOT EXISTS contract_move_out_notice_events_contract_idx
  ON public.contract_move_out_notice_events(organization_id, contract_id, created_at);
ALTER TABLE public.contract_move_out_notice_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_move_out_notice_events_select ON public.contract_move_out_notice_events;
CREATE POLICY contract_move_out_notice_events_select ON public.contract_move_out_notice_events
  FOR SELECT TO authenticated USING (
    organization_id = ANY(public.my_org_ids()) AND EXISTS (
      SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id = c.room_id
      WHERE c.id = contract_move_out_notice_events.contract_id
        AND c.organization_id = contract_move_out_notice_events.organization_id
        AND r.organization_id = c.organization_id
        AND public.can_access_building(r.building_id)
        AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('contracts.view', c.organization_id) s
          WHERE s.org_wide OR r.building_id = ANY(s.building_ids))
    )
  );
DROP POLICY IF EXISTS contract_move_out_notice_events_hide_sandbox_admin ON public.contract_move_out_notice_events;
CREATE POLICY contract_move_out_notice_events_hide_sandbox_admin ON public.contract_move_out_notice_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)
    OR COALESCE(organization_id = ANY(public.my_org_ids()), false))
  WITH CHECK (NOT COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)
    OR COALESCE(organization_id = ANY(public.my_org_ids()), false));
REVOKE ALL ON public.contract_move_out_notice_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.contract_move_out_notice_events TO authenticated;

CREATE OR REPLACE FUNCTION public.get_contract_move_out_notice_v1(p_organization_id uuid, p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $function$
DECLARE v_contract public.contracts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Notice organization unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_contract FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id AND r.organization_id = c.organization_id
    JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = c.organization_id
    JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'ACTIVE'
    WHERE c.id = p_contract_id AND c.organization_id = p_organization_id
      AND c.deleted_at IS NULL AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
      AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('contracts.view', p_organization_id) s
        WHERE s.org_wide OR b.id = ANY(s.building_ids));
  IF NOT FOUND THEN RAISE EXCEPTION 'Notice contract unavailable' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('contract_id', v_contract.id, 'organization_id', v_contract.organization_id,
    'expected_move_out_date', v_contract.expected_move_out_date, 'updated_at', v_contract.updated_at,
    'today', public.org_today_v1(v_contract.organization_id), 'status', v_contract.status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_contract_move_out_notice_v1(
  p_organization_id uuid, p_contract_id uuid, p_expected_updated_at timestamptz,
  p_expected_move_out_date date DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $function$
DECLARE
  v_contract public.contracts%ROWTYPE;
  v_building uuid;
  v_allowed boolean;
  v_reason text := nullif(btrim(p_reason), '');
  v_previous date;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Notice organization unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT c.* INTO v_contract FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id AND r.organization_id = c.organization_id
    JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = c.organization_id
    JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'ACTIVE'
    WHERE c.id = p_contract_id AND c.organization_id = p_organization_id
      AND c.deleted_at IS NULL AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
    FOR UPDATE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Notice contract unavailable' USING ERRCODE = '42501'; END IF;
  SELECT building_id INTO v_building FROM public.rooms WHERE id = v_contract.room_id FOR SHARE;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
    auth.uid(), p_organization_id, 'contracts.edit', v_building, NULL);
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'Not authorized to edit notice' USING ERRCODE = '42501';
  END IF;
  IF v_contract.status <> 'ACTIVE' OR v_contract.actual_end_date IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.contracts newer
       WHERE newer.room_id = v_contract.room_id AND newer.organization_id = p_organization_id
         AND newer.id <> v_contract.id AND newer.status = 'ACTIVE' AND newer.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Contract is no longer current' USING ERRCODE = '55000';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Notice snapshot changed; reload' USING ERRCODE = 'PT409';
  END IF;
  IF (p_expected_move_out_date IS NOT NULL AND (NOT isfinite(p_expected_move_out_date)
      OR p_expected_move_out_date < v_contract.start_date))
     OR length(v_reason) > 2000 OR (p_expected_move_out_date IS NULL AND v_reason IS NULL) THEN
    RAISE EXCEPTION 'Invalid notice date or reason' USING ERRCODE = '22023';
  END IF;
  v_previous := v_contract.expected_move_out_date;
  IF v_previous IS DISTINCT FROM p_expected_move_out_date THEN
    UPDATE public.contracts SET expected_move_out_date = p_expected_move_out_date,
      updated_at = clock_timestamp() WHERE id = v_contract.id RETURNING * INTO v_contract;
    INSERT INTO public.contract_move_out_notice_events(
      organization_id, contract_id, actor_id, previous_date, new_date, reason, contract_updated_at)
      VALUES (p_organization_id, v_contract.id, auth.uid(), v_previous,
        p_expected_move_out_date, v_reason, v_contract.updated_at);
  END IF;
  RETURN jsonb_build_object('contract_id', v_contract.id, 'organization_id', v_contract.organization_id,
    'expected_move_out_date', v_contract.expected_move_out_date, 'updated_at', v_contract.updated_at,
    'today', public.org_today_v1(v_contract.organization_id), 'status', v_contract.status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_due_contract_move_out_notices_v1(
  p_organization_id uuid, p_building_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $function$
DECLARE v_today date; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Notice organization unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid notice pagination' USING ERRCODE = '22023';
  END IF;
  v_today := public.org_today_v1(p_organization_id);
  WITH eligible AS MATERIALIZED (
    SELECT c.id AS contract_id, c.contract_number, b.name AS building_name, r.name AS room_name,
      c.expected_move_out_date, c.updated_at
    FROM public.contracts c
      JOIN public.rooms r ON r.id = c.room_id AND r.organization_id = c.organization_id
      JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = c.organization_id
      JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'ACTIVE'
    WHERE c.organization_id = p_organization_id AND c.status = 'ACTIVE'
      AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND c.expected_move_out_date <= v_today
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
      AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('contracts.view', p_organization_id) s
        WHERE s.org_wide OR b.id = ANY(s.building_ids))
  ), page AS (
    SELECT * FROM eligible ORDER BY expected_move_out_date, contract_id LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object('today', v_today, 'total', (SELECT count(*) FROM eligible),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY expected_move_out_date, contract_id) FROM page), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.get_contract_move_out_notice_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.set_contract_move_out_notice_v1(uuid,uuid,timestamptz,date,text) OWNER TO postgres;
ALTER FUNCTION public.list_due_contract_move_out_notices_v1(uuid,uuid[],integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_contract_move_out_notice_v1(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_contract_move_out_notice_v1(uuid,uuid,timestamptz,date,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_due_contract_move_out_notices_v1(uuid,uuid[],integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_contract_move_out_notice_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_contract_move_out_notice_v1(uuid,uuid,timestamptz,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_contract_move_out_notices_v1(uuid,uuid[],integer,integer) TO authenticated;
