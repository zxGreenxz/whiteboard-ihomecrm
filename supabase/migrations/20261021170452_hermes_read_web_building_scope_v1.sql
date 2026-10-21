-- Hermes read scope never wider than the web (21/10/2026, TEST): a Partner member whose role grants buildings.view on
-- 13 buildings, but whose member overrides grant tasks.view/invoices.view/income_expenses.view/meter_readings.view/
-- assets.view on the whole ORGANIZATION, asked the bot "Có việc nào đang mở không?". crm_read_tasks (hermes_domain_read_v1,
-- SECURITY DEFINER) returned 15 open tasks, 5 of them in a building outside those 13; the web (RLS jobs_select_rbac) shows 10.
-- Measured on TEST with the live connection (ROLLBACK): tasks, invoices, receivables, meter_readings, income_expenses and the
-- v3 invoice_report all returned rows of 5–6 buildings the asker cannot open on the web; a building manager whose read keys
-- equal buildings.view saw no difference.
--
-- Root cause: every building-bound SELECT policy of the web filters rows by buildings.view, independent of the module key —
-- has_full_building_scope() OR building_id IN accessible_building_ids() (= app_private.buildings_for_v3('buildings.view'))
-- on jobs/invoices/meter_readings/income_expenses/rooms/contracts (via rooms), can_access_building() (= can_v3
-- ('buildings.view',…)) on assets/leads/deposits/building_services. The SECURITY DEFINER readers of Hermes bypass that RLS and
-- take the building set of the domain key alone (app_private.authorized_scope_v3(<key>,org)): a key granted wider than
-- buildings.view (here a member override on ORGANIZATION) widened the bot past the web. The wave-2 report packages already
-- intersect with the web set (20261019040948, hermes_w2a_read_v1: "giao thêm để không vượt web") and run under RLS; the four
-- grant helpers below did not.
--
-- Fix (one rule, four helpers; no reader body, no input/result key, no tools/list byte changes):
--   app_private.hermes_web_building_ids_v1(org) — NEW: the buildings of the company the asker's web building filter shows
--     (has_full_building_scope() ⇒ every live building; else buildings_for_v3('buildings.view')).
--   public.hermes_domain_capabilities_v1        — family v1 capabilities and the building set of hermes_domain_read_v1;
--   app_private.hermes_domain_grant_v2          — hermes_domain_read_v2/v3, hermes_full_read_scope_v1, hermes_w2_grant_v1;
--   app_private.hermes_metadata_domain_grant_v1 — capabilities v2/v3, the fast-read scope, the room page admission;
--   app_private.hermes_task_follow_buildings_v1 — crm_task_follow lists (role team/assigned_*) and the follow guard.
--   Each keeps its body byte-for-byte and adds ONE conjunct: the building must also be in hermes_web_building_ids_v1.
--   allowed/companyEnabled/orgWide are unchanged: rows WITHOUT a building (jobs, leads, assets, customers without a contract,
--   organization reports) keep the web's module-key rule (can_access_org_entity), which a building filter never covered.
-- Effect: a connection reads at most what the asker reads on the web; when a read key is narrower than buildings.view nothing
-- changes. Not changed here (same pattern, outside the crm_read_* surface): hermes_scope_buildings_v1('rooms.view') of the sale
-- listing/room scope map, the action capabilities (task create, expense, room pass) and standing follow reminders
-- (hermes_task_follow_grant_v1). Prepared rollback (not a migration):
-- docs/plans/hermes-crm/revert/hermes_read_web_building_scope_revert_v1.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record; sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.authorized_scope_v3(text,uuid)','app_private.buildings_for_v3(text)','public.has_full_building_scope()',
    'public.get_authorization_context_v1(uuid)','app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
      THEN RAISE EXCEPTION 'hermes_web_building_scope_dependency_invalid: %',sig; END IF;
  END LOOP;
  -- The four helpers this file replaces: the reviewed bodies (per-key scope) or this file's (second run).
  FOR p IN SELECT x.sig,q.oid,q.prosrc,q.prosecdef,q.provolatile,pg_get_userbyid(q.proowner) owner,x.anchor,x.vol
    FROM (VALUES ('public.hermes_domain_capabilities_v1(uuid)','authorized_scope_v3(key,p_organization_id)','s'),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','authorized_scope_v3(p_key,p_org)','v'),
      ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','authorized_scope_v3(p_key,p_org)','s'),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)','authorized_scope_v3(p_crm,c.organization_id)','v')) x(sig,anchor,vol)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    IF p.oid IS NULL OR NOT p.prosecdef OR p.provolatile<>p.vol OR p.owner<>'postgres' OR position(p.anchor IN p.prosrc)=0
      THEN RAISE EXCEPTION 'hermes_web_building_scope_requires_reviewed_helper: %',p.sig; END IF;
  END LOOP;
END $requires$;

-- The buildings of p_org the asker's web building filter shows: the predicate of every building-bound SELECT policy
-- (has_full_building_scope() OR building_id IN accessible_building_ids(); can_access_building() is the per-row form of the
-- same buildings.view resolver). Callers are SECURITY DEFINER helpers of the asker's own request (auth.uid() is the asker).
CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_full boolean; v_visible uuid[]:='{}'::uuid[];
BEGIN
  IF p_org IS NULL OR auth.uid() IS NULL THEN RETURN '{}'::uuid[]; END IF;
  v_full:=COALESCE(public.has_full_building_scope(),false);
  IF NOT v_full THEN v_visible:=COALESCE(app_private.buildings_for_v3('buildings.view'),'{}'::uuid[]); END IF;
  RETURN (SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
    WHERE b.organization_id=p_org AND b.deleted_at IS NULL AND (v_full OR b.id=ANY(v_visible)));
END $fn$;

-- The 20261019034254 body with one change: buildingIds ∩ hermes_web_building_ids_v1 (v_web).
CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text;
  result jsonb:='{}'; enabled boolean; allowed boolean; buildings uuid[]; v_web uuid[];
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
  -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
  v_web:=app_private.hermes_web_building_ids_v1(p_organization_id);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    allowed:=enabled AND context->'permissions'->key='true'::jsonb;
    buildings:='{}';
    IF COALESCE(allowed,false) THEN
      SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM app_private.authorized_scope_v3(key,p_organization_id) scope
      JOIN public.buildings b ON b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids)) AND b.id=ANY(v_web);
      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
    END IF;
    result:=result||jsonb_build_object(key,jsonb_build_object('allowed',COALESCE(allowed,false),'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

-- The 20261015120000 body with one change: buildingIds ∩ hermes_web_building_ids_v1 (v_web); orgWide unchanged.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_grant_v2(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[]; v_web uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(bool_or(scope.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
    v_web:=app_private.hermes_web_building_ids_v1(p_org);
    SELECT COALESCE(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings
      FROM app_private.authorized_scope_v3(p_key,p_org) scope
      JOIN public.buildings b ON b.organization_id=p_org AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids)) AND b.id=ANY(v_web);
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- The 20261019034254 body with the same one change.
CREATE OR REPLACE FUNCTION app_private.hermes_metadata_domain_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[]; v_web uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(bool_or(scope.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
    v_web:=app_private.hermes_web_building_ids_v1(p_org);
    SELECT COALESCE(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings
      FROM app_private.authorized_scope_v3(p_key,p_org) scope
      JOIN public.buildings b ON b.organization_id=p_org AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids)) AND b.id=ANY(v_web);
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- The 20261015110000 body with the same one change (crm_task_follow lists and the follow guard).
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_buildings_v1(c app_private.hermes_connections,p_crm text)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; v_scopes uuid[]; v_result uuid[]; v_web uuid[];
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
  v_web:=app_private.hermes_web_building_ids_v1(c.organization_id);
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_result
    FROM public.buildings b CROSS JOIN app_private.authorized_scope_v3(p_crm,c.organization_id) scope
    WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL AND b.id=ANY(v_web)
      AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
      AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id AND overlay.id=ANY(v_scopes)
        AND (overlay.scope_type='ORGANIZATION' OR (overlay.scope_type='BUILDING' AND overlay.building_id=b.id)
          OR (overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
            ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
            WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id))));
  IF cardinality(v_result)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
  RETURN v_result;
END $fn$;

ALTER FUNCTION app_private.hermes_web_building_ids_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_capabilities_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v1(uuid) TO authenticated;

DO $assert$
DECLARE p record;
BEGIN
  FOR p IN SELECT x.sig,q.oid,q.prosrc,q.prosecdef,q.provolatile,pg_get_userbyid(q.proowner) owner,
      replace(COALESCE(array_to_string(q.proconfig,','),''),'"','') cfg,x.vol,x.caller
    FROM (VALUES ('app_private.hermes_web_building_ids_v1(uuid)','s',false),('public.hermes_domain_capabilities_v1(uuid)','s',true),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','v',false),
      ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','s',false),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)','v',false)) x(sig,vol,caller)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    IF p.oid IS NULL OR NOT p.prosecdef OR p.provolatile<>p.vol OR p.owner<>'postgres' OR p.cfg<>'search_path=pg_catalog, public, app_private'
      OR has_function_privilege('authenticated',p.sig,'EXECUTE') IS DISTINCT FROM p.caller
      OR has_function_privilege('anon',p.sig,'EXECUTE') OR has_function_privilege('service_role',p.sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',p.sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_web_building_scope_contract_violated: %',p.sig; END IF;
    IF p.sig<>'app_private.hermes_web_building_ids_v1(uuid)' AND (position('v_web:=app_private.hermes_web_building_ids_v1(' IN p.prosrc)=0
      OR position('b.id=ANY(v_web)' IN p.prosrc)=0)
      THEN RAISE EXCEPTION 'hermes_web_building_scope_missing: %',p.sig; END IF;
  END LOOP;
  SELECT prosrc INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)');
  IF position('public.has_full_building_scope()' IN p.prosrc)=0 OR position('app_private.buildings_for_v3(''buildings.view'')' IN p.prosrc)=0
    OR position('b.deleted_at IS NULL' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_web_building_scope_helper_changed'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
