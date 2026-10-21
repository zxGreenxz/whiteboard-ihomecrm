-- REVERT of 20261021170452_hermes_read_web_building_scope_v1.sql — prepared 21/10/2026 next to the forward file; NOT a
-- migration (docs/plans/hermes-crm/revert/). Returns the four helpers to their exact previous bodies — the building set of
-- the domain key alone (authorized_scope_v3), WITHOUT the web building filter (buildings.view) — and drops
-- app_private.hermes_web_building_ids_v1. Signatures, owner and ACL unchanged.
-- WARNING: this re-opens the read leak the forward file closed (a read key granted wider than buildings.view lets Hermes read
-- buildings the web hides). Use only when the forward file itself breaks reads, and re-apply a fixed forward file soon.
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs
-- hermes_read_web_building_scope_revert_v1` gives; move the four forward pins (scripts/__tests__/hermes-durable-forward-fixture.mjs)
-- to the new file, drop the helper's pin; TEST lane, then production.
-- $requires$ refuses to run over other bodies; idempotent (CREATE OR REPLACE, DROP FUNCTION IF EXISTS).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  FOR p IN SELECT x.sig,q.oid,q.prosrc FROM (VALUES ('public.hermes_domain_capabilities_v1(uuid)'),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)'),('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)'),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)')) x(sig)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    -- The forward bodies, or (second run) the previous ones this file restores.
    IF p.oid IS NULL OR position('authorized_scope_v3(' IN p.prosrc)=0
      THEN RAISE EXCEPTION 'hermes_web_building_scope_revert_unexpected: %',p.sig; END IF;
  END LOOP;
END $requires$;

-- 20261019034254, verbatim.
CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text;
  result jsonb:='{}'; enabled boolean; allowed boolean; buildings uuid[];
  keys text[]:=ARRAY['customers.view','leads.view','contracts.view','invoices.view','assets.view','services.view','tasks.view','reports_real_estate.occupancy'];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    allowed:=enabled AND context->'permissions'->key='true'::jsonb;
    buildings:='{}';
    IF COALESCE(allowed,false) THEN
      SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM app_private.authorized_scope_v3(key,p_organization_id) scope
      JOIN public.buildings b ON b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
    END IF;
    result:=result||jsonb_build_object(key,jsonb_build_object('allowed',COALESCE(allowed,false),'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

-- 20261015120000, verbatim.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_grant_v2(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(bool_or(scope.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    SELECT COALESCE(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings
      FROM app_private.authorized_scope_v3(p_key,p_org) scope
      JOIN public.buildings b ON b.organization_id=p_org AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- 20261019034254, verbatim.
CREATE OR REPLACE FUNCTION app_private.hermes_metadata_domain_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(bool_or(scope.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    SELECT COALESCE(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings
      FROM app_private.authorized_scope_v3(p_key,p_org) scope
      JOIN public.buildings b ON b.organization_id=p_org AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- 20261015110000, verbatim.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_buildings_v1(c app_private.hermes_connections,p_crm text)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; v_scopes uuid[]; v_result uuid[];
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_result
    FROM public.buildings b CROSS JOIN app_private.authorized_scope_v3(p_crm,c.organization_id) scope
    WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
      AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
      AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id AND overlay.id=ANY(v_scopes)
        AND (overlay.scope_type='ORGANIZATION' OR (overlay.scope_type='BUILDING' AND overlay.building_id=b.id)
          OR (overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
            ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
            WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id))));
  IF cardinality(v_result)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
  RETURN v_result;
END $fn$;

-- No body binds the helper any more.
DROP FUNCTION IF EXISTS app_private.hermes_web_building_ids_v1(uuid);

ALTER FUNCTION public.hermes_domain_capabilities_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v1(uuid) TO authenticated;

DO $assert$
DECLARE p record;
BEGIN
  IF to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)') IS NOT NULL
    THEN RAISE EXCEPTION 'hermes_web_building_scope_revert_helper_left'; END IF;
  -- md5(prosrc) of the previous bodies (production before the forward file, 21/10/2026).
  FOR p IN SELECT x.sig,x.digest,q.oid,md5(q.prosrc) actual FROM (VALUES
      ('public.hermes_domain_capabilities_v1(uuid)','73ae6a7e6939694d30153de6c4647a19'),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','e9f287dc65d6e2f49c747d1cf6cd4d7c'),
      ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','e9f287dc65d6e2f49c747d1cf6cd4d7c'),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)','52b2720a8d4a060a576968d5236f3886')) x(sig,digest)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    IF p.oid IS NULL OR p.actual IS DISTINCT FROM p.digest
      THEN RAISE EXCEPTION 'hermes_web_building_scope_revert_body_unexpected: %',p.sig; END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated','public.hermes_domain_capabilities_v1(uuid)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_domain_capabilities_v1(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_web_building_scope_revert_acl_unexpected'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
