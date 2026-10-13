-- Register the first read-only business capability. Existing company ceilings
-- and connections remain unchanged: registration alone grants no assistant access.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
VALUES ('rooms.view','read',true) ON CONFLICT (capability) DO NOTHING;

-- A final decision in ONE statement snapshot. STABLE is essential: every read
-- below, including the canonical STABLE CRM resolvers, sees the same snapshot.
-- No volatile membership helper, lock/writer protocol or separately awaited
-- authorization read can mix a new AREA map with an old connection/policy.
-- This observes the RPC snapshot, not future changes after that decision point.
-- The JWT must be the assistant's verified provider session. tokenDigest and
-- expected versions are bound by the trusted backend, never tool/model inputs.
-- Scope identifiers are authorization_scopes.id, not building/account ids.
CREATE OR REPLACE FUNCTION public.hermes_room_scope_map_v1(p_organization_id uuid,p_scope_ids uuid[],
  p_connection_id uuid,p_token_digest text,p_expected_epoch bigint,p_expected_policy_version bigint,
  p_expected_membership_id uuid,p_expected_authorization_version bigint,p_expected_session_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_buildings uuid[]; v_scopes jsonb; v_edges jsonb; v_auth jsonb; v_allowed uuid[];
  v_actor uuid:=auth.uid(); v_now timestamptz:=clock_timestamp(); v_count integer;
  v_c app_private.hermes_connections; v_s app_private.hermes_sessions;
  v_p app_private.hermes_org_policies; v_t app_private.hermes_connection_tokens;
  v_member public.organization_memberships;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_organization_id IS NULL
    OR p_connection_id IS NULL OR p_expected_membership_id IS NULL OR p_token_digest IS NULL
    OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_expected_epoch IS NULL OR p_expected_epoch<1
    OR p_expected_policy_version IS NULL OR p_expected_policy_version<1
    OR p_expected_authorization_version IS NULL OR p_expected_authorization_version<1
    OR p_expected_session_revision IS NULL OR p_expected_session_revision<1 THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  IF p_scope_ids IS NULL OR cardinality(p_scope_ids)<1 OR cardinality(p_scope_ids)>256
    OR array_ndims(p_scope_ids)<>1 OR array_position(p_scope_ids,NULL) IS NOT NULL
    OR cardinality(p_scope_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_scope_ids) id) THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_c FROM app_private.hermes_connections
    WHERE id=p_connection_id AND organization_id=p_organization_id AND user_id=v_actor AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_s FROM app_private.hermes_sessions
    WHERE id=v_c.credential_ref AND assistant_id=v_c.assistant_id AND organization_id=p_organization_id
      AND user_id=v_actor AND provider_session_id::text=auth.jwt()->>'session_id'
      AND state='ACTIVE' AND quarantine_reason IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_t FROM app_private.hermes_connection_tokens
    WHERE token_digest=p_token_digest AND connection_id=v_c.id AND revoked_at IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_org_policies WHERE organization_id=p_organization_id AND enabled;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a
    WHERE a.id=v_c.assistant_id AND a.organization_id=p_organization_id AND a.user_id=v_actor AND a.state='ACTIVE')
    OR NOT ('rooms.view'=ANY(v_c.read_capabilities)) OR NOT ('rooms.view'=ANY(v_p.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap
      WHERE cap.capability='rooms.view' AND cap.mode='read' AND cap.enabled) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_c.epoch<>p_expected_epoch OR v_p.version<>p_expected_policy_version OR v_s.revision<>p_expected_session_revision THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_allowed FROM (
    SELECT unnest(v_c.scope_ids) AS id INTERSECT SELECT unnest(v_p.scope_ids) AS id
  ) allowed;
  IF NOT(p_scope_ids<@v_allowed) OR NOT(v_allowed<@p_scope_ids) THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;

  -- Identity/lifetime parity with hermes_member_v1, without calling that VOLATILE
  -- helper inside a coherent read. Permissions remain the shared CRM resolver's.
  SELECT count(*) INTO v_count FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=v_actor AND m.organization_id=p_organization_id AND o.status='ACTIVE'
      AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_member FROM public.organization_memberships
    WHERE id=p_expected_membership_id AND user_id=v_actor AND organization_id=p_organization_id
      AND status='ACTIVE' AND revoked_at IS NULL
      AND COALESCE(valid_from,'-infinity'::timestamptz)<=v_now AND (valid_to IS NULL OR valid_to>v_now);
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=v_actor) THEN
    SELECT count(DISTINCT m.organization_id) INTO v_count FROM public.organization_memberships m
      JOIN public.organizations o ON o.id=m.organization_id
      WHERE m.user_id=v_actor AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
    IF v_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous' USING ERRCODE='42501'; END IF;
  END IF;
  -- require_perm_v1 supplies no target building and would reject legitimate
  -- BUILDING/AREA-scoped readers. Use the same boolean + concrete scope resolver
  -- as the canonical CRM read adapter, then intersect every mapped building.
  v_auth:=public.get_authorization_context_v1(p_organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->'permissions'->'rooms.view' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_auth->>'membershipId' IS DISTINCT FROM p_expected_membership_id::text
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM p_expected_authorization_version::text THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',p_organization_id);
  IF v_buildings IS NULL OR cardinality(v_buildings)<1 OR cardinality(v_buildings)>256 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  -- Reject an incomplete/foreign/deleted mapping rather than silently dropping
  -- requested nodes. CASHBOOK is metadata only and grants zero room buildings.
  IF EXISTS (
    SELECT 1 FROM unnest(p_scope_ids) requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.authorization_scopes s
      WHERE s.id=requested.id AND s.organization_id=p_organization_id AND (
        s.scope_type='ORGANIZATION'
        OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a
          WHERE a.id=s.area_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
        OR (s.scope_type='BUILDING' AND EXISTS(SELECT 1 FROM public.buildings b
          WHERE b.id=s.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL))
        OR (s.scope_type='CASHBOOK' AND EXISTS(SELECT 1 FROM public.accounts a
          WHERE a.id=s.cashbook_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
      )
    )
  ) THEN RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;

  SELECT jsonb_agg(jsonb_build_object('id',s.id,'scopeType',s.scope_type,
    'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',s.cashbook_id) ORDER BY s.id)
    INTO v_scopes FROM public.authorization_scopes s
    WHERE s.organization_id=p_organization_id AND s.id=ANY(p_scope_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',ab.organization_id,
    'areaId',ab.area_id,'buildingId',ab.building_id) ORDER BY ab.area_id,ab.building_id),'[]'::jsonb)
    INTO v_edges
    FROM public.area_buildings ab
    JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
    JOIN public.buildings b ON b.id=ab.building_id AND b.organization_id=ab.organization_id AND b.deleted_at IS NULL
    WHERE ab.organization_id=p_organization_id AND ab.building_id=ANY(v_buildings)
      AND EXISTS(SELECT 1 FROM public.authorization_scopes s WHERE s.organization_id=p_organization_id
        AND s.id=ANY(p_scope_ids) AND s.scope_type='AREA' AND s.area_id=ab.area_id);
  IF jsonb_array_length(v_scopes)<>cardinality(p_scope_ids) OR jsonb_array_length(v_edges)>=4096 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  IF v_s.expires_at<=clock_timestamp() OR v_t.expires_at<=clock_timestamp()
    OR (v_member.valid_to IS NOT NULL AND v_member.valid_to<=clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',p_organization_id,'complete',true,
    'scopes',v_scopes,'areaBuildings',v_edges,'permissionBuildingIds',to_jsonb(v_buildings),
    'binding',jsonb_build_object('connectionId',v_c.id,'epoch',v_c.epoch,'policyVersion',v_p.version,
      'membershipId',v_member.id,'authorizationVersion',p_expected_authorization_version,'sessionRevision',v_s.revision));
END
$fn$;

-- Report only the explicit read capabilities implemented at this stage, using
-- current CRM authorization. Registration/policy never overrides the human user.
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v1(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_c app_private.hermes_connections; v_p app_private.hermes_org_policies;
  v_member jsonb; v_auth jsonb; v_read jsonb; v_buildings uuid[];
BEGIN
  SELECT * INTO v_c FROM app_private.hermes_connections WHERE id=p_connection_id AND user_id=auth.uid();
  IF NOT FOUND OR v_c.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(auth.uid(),v_c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_org_policies WHERE organization_id=v_c.organization_id;
  IF NOT FOUND OR NOT v_p.enabled OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=v_c.assistant_id AND a.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_sessions s WHERE s.id=v_c.credential_ref AND s.state='ACTIVE' AND s.quarantine_reason IS NULL AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=v_c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501';
  END IF;
  v_auth:=public.get_authorization_context_v1(v_c.organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM v_c.organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_buildings:=public.copilot_org_scope_buildings_v1('rooms.view',v_c.organization_id);
  SELECT COALESCE(jsonb_agg(cap.capability ORDER BY cap.capability),'[]'::jsonb) INTO v_read
    FROM app_private.hermes_capabilities cap WHERE cap.mode='read' AND cap.enabled
      AND cap.capability=ANY(v_c.read_capabilities) AND cap.capability=ANY(v_p.read_capabilities)
      AND (cap.capability='assistant.context.read' OR
        (cap.capability='rooms.view' AND v_auth->'permissions'->'rooms.view'='true'::jsonb
          AND cardinality(v_buildings)>0));
  RETURN app_private.hermes_connection_json_v1(v_c)||v_member||jsonb_build_object('policyVersion',v_p.version,
    'companyCeilings',jsonb_build_object('read',v_p.read_capabilities,'action',v_p.action_capabilities),
    'effective',jsonb_build_object('read',v_read,'action','[]'::jsonb));
END
$fn$;

ALTER FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_context_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint),public.hermes_connection_context_v1(uuid)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint),public.hermes_connection_context_v1(uuid) TO authenticated;
COMMIT;
