-- Self-owned enrollment choices only. Existing CRM grants and Hermes policy
-- remain unchanged; choosing an item here never authorizes a runtime tool.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.hermes_connection_options_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_member jsonb; v_auth jsonb;
  v_policy app_private.hermes_org_policies; v_buildings uuid[]; v_scopes jsonb:='[]'::jsonb;
  v_read jsonb:='[]'::jsonb; v_enabled boolean:=false;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  v_member:=app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_auth:=public.get_authorization_context_v1(p_org);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_org::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->>'membershipId' IS DISTINCT FROM v_member->>'membershipId'
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM v_member->>'authorizationVersion' THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO v_policy FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  v_enabled:=FOUND AND v_policy.enabled;
  IF v_enabled THEN
    IF 'assistant.context.read'=ANY(v_policy.read_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities
      WHERE capability='assistant.context.read' AND mode='read' AND enabled) THEN
      v_read:=v_read||'"assistant.context.read"'::jsonb;
    END IF;
    IF 'rooms.view'=ANY(v_policy.read_capabilities) AND v_auth->'permissions'->'rooms.view'='true'::jsonb
      AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled) THEN
      v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',p_org);
      IF v_buildings IS NULL OR cardinality(v_buildings)>256 THEN
        RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',s.id,'scopeType',s.scope_type,
        'label',app_private.scope_label_v1(s.id),'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',NULL) ORDER BY s.id),'[]'::jsonb)
        INTO v_scopes FROM public.authorization_scopes s
        WHERE s.organization_id=p_org AND s.id=ANY(v_policy.scope_ids) AND s.scope_type IN ('ORGANIZATION','AREA','BUILDING')
          AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=ANY(v_buildings) AND b.organization_id=p_org AND b.deleted_at IS NULL
            AND (s.scope_type='ORGANIZATION' OR (s.scope_type='BUILDING' AND s.building_id=b.id)
              OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a JOIN public.area_buildings ab
                ON ab.area_id=a.id AND ab.organization_id=a.organization_id
                WHERE a.id=s.area_id AND a.organization_id=p_org AND a.deleted_at IS NULL AND ab.building_id=b.id))));
      IF jsonb_array_length(v_scopes)>256 THEN RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(v_scopes)>0 THEN v_read:=v_read||'"rooms.view"'::jsonb; END IF;
    END IF;
  END IF;
  -- A bounded observation, not a lease: enrollment and every runtime call
  -- independently recheck live user/company/policy/scope authority.
  RETURN v_member||jsonb_build_object('userId',v_actor,'organizationId',p_org,
    'policyVersion',COALESCE(v_policy.version,0),'enabled',v_enabled,'read',v_read,'action','[]'::jsonb,'scopes',v_scopes);
END
$fn$;
ALTER FUNCTION public.hermes_connection_options_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v1(uuid) TO authenticated;
COMMIT;
