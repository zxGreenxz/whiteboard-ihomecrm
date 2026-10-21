-- Hermes read scope never wider than the web (21/10/2026, TEST): a Partner member whose role grants buildings.view on
-- 13 buildings, but whose member overrides grant tasks.view/invoices.view/income_expenses.view/meter_readings.view/
-- assets.view on the whole ORGANIZATION, asked the bot "Có việc nào đang mở không?". crm_read_tasks (hermes_domain_read_v1,
-- SECURITY DEFINER) returned 15 open tasks, 5 of them in a building outside those 13; the web (RLS jobs_select_rbac) shows 10.
-- Measured on TEST with the live connection (ROLLBACK): tasks, invoices, receivables, meter_readings, income_expenses and the
-- v3 invoice_report all returned rows of 5–6 buildings the asker cannot open on the web; a building manager whose read keys
-- equal buildings.view saw no difference.
--
-- Root cause: every building-bound SELECT policy of the web filters rows by buildings.view, independent of the module key —
-- has_full_building_scope() OR building_id IN accessible_building_ids() on jobs/invoices/meter_readings/income_expenses/
-- rooms/contracts (via rooms), can_access_building() on assets/leads/deposits/building_services. The SECURITY DEFINER readers
-- of Hermes bypass that RLS and took the building set of the domain key alone (app_private.authorized_scope_v3(<key>,org)): a
-- key granted wider than buildings.view (here a member override on ORGANIZATION) widened the bot past the web. The wave-2
-- report packages already intersect with the web set (20261019040948, hermes_w2a_read_v1) and run under RLS.
--
-- Fix (no input/result key, no tools/list byte changes; the connector is unchanged):
--   app_private.hermes_web_building_ids_v1(org) — NEW: the buildings of the company the asker's web building filter shows.
--   public.hermes_domain_capabilities_v1        — family v1: every key ∩ the web set (its customers branch shows contract and
--                                                  building ids without a contracts.view gate, so customers.view narrows too);
--   app_private.hermes_domain_grant_v2          — v2/v3 readers, hermes_full_read_scope_v1, hermes_w2_grant_v1;
--   app_private.hermes_metadata_domain_grant_v1 — capabilities v2/v3, the fast-read scope, the room page admission;
--   app_private.hermes_task_follow_buildings_v1 — crm_task_follow lists (role team/assigned_*) and the follow guard;
--   public.hermes_domain_read_v2                — income_expenses: the web filter in the reader (see below).
--   The two grants intersect every key with the web set EXCEPT the two whose web policy also has a branch outside
--   buildings.view, so the grant keeps the key scope and the reader applies the web filter itself:
--   - customers.view (customers_select_rbac: any customers.view, no building): v3 shows a contract, building or room only
--     through the contracts.view scope (narrowed); the fast reader runs under RLS. Keeping the key scope also keeps the R2d
--     rule "withoutContract is null when the contract scope does not cover the customer scope" true for Toàn tổ chức.
--   - income_expenses.view (income_expenses_select_fund_member: the vouchers of the cashbooks the asker holds, in any
--     building): v2 shows a voucher of the key scope ∩ overlay when its building is in the web set OR its account/change/
--     rounding account is one of accessible_account_ids(); outside the web set it names neither its building nor its room
--     (the web embeds buildings/rooms under RLS). The capabilities v2 fence keeps the key scope so the connector accepts it.
--   allowed/companyEnabled/orgWide are unchanged: rows WITHOUT a building keep the web's module-key rule.
--   Cost: each grant reads authorized_scope_v3 of its key once (was twice) and the web set once (one authorized_scope_v3 for
--   this company), so a catalog build calls the resolver about as often as before.
-- Not changed here (same pattern, recorded in tooling/known-gaps.yaml): hermes_scope_buildings_v1('rooms.view') (sale listing,
-- room scope map, crm_auth_context buildings), the action capabilities and the standing follow reminders.
-- Prepared rollback (not a migration): docs/plans/hermes-crm/revert/hermes_read_web_building_scope_revert_v1.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record; sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.authorized_scope_v3(text,uuid)','public.has_full_building_scope()','public.accessible_account_ids()',
    'public.get_authorization_context_v1(uuid)','app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
      THEN RAISE EXCEPTION 'hermes_web_building_scope_dependency_invalid: %',sig; END IF;
  END LOOP;
  -- Each function this file replaces carries the reviewed previous body (md5 of production 21/10/2026) or this file's
  -- (second run); carriage returns stripped. The new helper may be absent (first run) or this file's.
  FOR p IN SELECT x.sig,x.old_md5,x.new_md5,x.vol,q.oid,q.prosrc,q.prosecdef,q.provolatile,pg_get_userbyid(q.proowner) owner
    FROM (VALUES ('app_private.hermes_web_building_ids_v1(uuid)','','b2d79a218e3f389295151ca9a10c6ce5','s'),
      ('public.hermes_domain_capabilities_v1(uuid)','73ae6a7e6939694d30153de6c4647a19','256a0f6d21e930249b39e6d2cdd56f63','s'),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','e9f287dc65d6e2f49c747d1cf6cd4d7c','39514ae1eda3dc2baaea20eb5b4ae537','v'),
      ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','e9f287dc65d6e2f49c747d1cf6cd4d7c','39514ae1eda3dc2baaea20eb5b4ae537','s'),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)','52b2720a8d4a060a576968d5236f3886','a666f5cbd6ab7d87031616c30fb3bac0','v'),
      ('public.hermes_domain_read_v2(jsonb,text,jsonb)','a7e7b7586b4e43b562a908ce49ed1763','32f362d61c2861696e56ef355372b7d4','v')) x(sig,old_md5,new_md5,vol)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    IF p.oid IS NULL THEN
      IF p.old_md5<>'' THEN RAISE EXCEPTION 'hermes_web_building_scope_requires_reviewed_body: % missing',p.sig; END IF;
    ELSIF NOT p.prosecdef OR p.provolatile<>p.vol OR p.owner<>'postgres' OR md5(replace(p.prosrc,chr(13),'')) NOT IN (p.old_md5,p.new_md5)
      THEN RAISE EXCEPTION 'hermes_web_building_scope_requires_reviewed_body: %',p.sig; END IF;
  END LOOP;
END $requires$;

-- The buildings of p_org the asker's web building filter shows: every live building for has_full_building_scope() (super
-- admin), otherwise the buildings.view set of authorized_scope_v3 — the set form of the resolver behind
-- accessible_building_ids() (buildings_for_v3), read for this one company (a Hermes asker is a member of exactly one company:
-- hermes_member_v1). It equals the web filter of jobs/invoices/meter_readings/income_expenses/rooms/contracts. Policies using
-- the per-row form can_access_building() (can_v3: assets/leads/deposits/building_services) can differ on DENY edge cases
-- (can_v3 ignores a DENY binding with an end date and honours a DENY of an inactive role). Callers are SECURITY DEFINER
-- helpers of the asker's own request (auth.uid() is the asker).
CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_full boolean; v_org_wide boolean:=false; v_scope uuid[]:='{}'::uuid[];
BEGIN
  IF p_org IS NULL OR auth.uid() IS NULL THEN RETURN '{}'::uuid[]; END IF;
  v_full:=COALESCE(public.has_full_building_scope(),false);
  IF NOT v_full THEN
    SELECT COALESCE(scope.org_wide,false),COALESCE(scope.building_ids,'{}'::uuid[]) INTO v_org_wide,v_scope
      FROM app_private.authorized_scope_v3('buildings.view',p_org) scope;
  END IF;
  RETURN (SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
    WHERE b.organization_id=p_org AND b.deleted_at IS NULL AND (v_full OR COALESCE(v_org_wide,false) OR b.id=ANY(v_scope)));
END $fn$;

-- The 20261019034254 body with one change: buildingIds ∩ hermes_web_building_ids_v1 (v_web) for every key.
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

-- The 20261015120000 grant: authorized_scope_v3 of the key read once (it returns exactly one row), then buildingIds ∩
-- hermes_web_building_ids_v1 (v_web) except for customers.view and income_expenses.view (header). orgWide unchanged.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_grant_v2(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[]; v_scope uuid[]; v_web uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(scope.org_wide,false),COALESCE(scope.building_ids,'{}'::uuid[]) INTO v_org_wide,v_scope
      FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    v_org_wide:=COALESCE(v_org_wide,false);
    -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
    IF p_key NOT IN ('customers.view','income_expenses.view') THEN v_web:=app_private.hermes_web_building_ids_v1(p_org); END IF;
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
      WHERE b.organization_id=p_org AND b.deleted_at IS NULL AND (v_org_wide OR b.id=ANY(v_scope))
        AND (v_web IS NULL OR b.id=ANY(v_web));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- The 20261019034254 grant with the same changes (the two grants keep identical bodies).
CREATE OR REPLACE FUNCTION app_private.hermes_metadata_domain_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[]; v_scope uuid[]; v_web uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(scope.org_wide,false),COALESCE(scope.building_ids,'{}'::uuid[]) INTO v_org_wide,v_scope
      FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    v_org_wide:=COALESCE(v_org_wide,false);
    -- Web parity (20261021170452): a key never reaches a building the asker's web RLS (buildings.view) hides.
    IF p_key NOT IN ('customers.view','income_expenses.view') THEN v_web:=app_private.hermes_web_building_ids_v1(p_org); END IF;
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
      WHERE b.organization_id=p_org AND b.deleted_at IS NULL AND (v_org_wide OR b.id=ANY(v_scope))
        AND (v_web IS NULL OR b.id=ANY(v_web));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

-- The 20261015110000 body with one change (crm_task_follow lists and the follow guard).
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

-- The 20261021035022 (R2c) body with one change in income_expenses (rows and summary): the web filter of the reader —
-- building in the web set (v_web) OR the account/change/rounding account in accessible_account_ids() (v_accounts) — inside
-- the key scope ∩ overlay (buildings); outside v_web a voucher names neither its building nor its room.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v2(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; v_source text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; v_from date; v_to date; rows jsonb; next_cursor uuid; v_summary jsonb; v_web uuid[]; v_accounts uuid[]:='{}'::uuid[];
BEGIN
  permission:=CASE p_domain WHEN 'income_expenses' THEN 'income_expenses.view' WHEN 'receivables' THEN 'invoices.view'
    WHEN 'meter_readings' THEN 'meter_readings.view' WHEN 'deposits_held' THEN 'deposits.view'
    WHEN 'building_profit' THEN 'reports_finance.analysis' END;
  v_source:=CASE p_domain WHEN 'income_expenses' THEN 'crm.income_expenses' WHEN 'receivables' THEN 'crm.invoices'
    WHEN 'meter_readings' THEN 'crm.meter_readings' WHEN 'deposits_held' THEN 'crm.get_held_deposit_summary'
    WHEN 'building_profit' THEN 'crm.fa_monthly_pnl' END;
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status','fromDate','toDate']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  row_limit:=app_private.hermes_integer_v1(p_input->'limit');
  query:=p_input->>'query'; v_status:=p_input->>'status';
  IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
    OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
    OR (p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR NOT (
      (p_domain='income_expenses' AND v_status IN ('UNAPPROVED','APPROVED','CANCELLED')) OR
      (p_domain='receivables' AND v_status IN ('APPROVED','PARTIAL_PAID','OVERDUE')) OR
      (p_domain='meter_readings' AND v_status IN ('UNAPPROVED','APPROVED')))))
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate');
  v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
  IF (v_from IS NOT NULL AND v_to IS NOT NULL AND v_to<v_from)
    OR (p_domain='deposits_held' AND (v_from IS NOT NULL OR v_to IS NOT NULL))
    OR (p_domain='building_profit' AND (v_from IS NULL OR v_to IS NULL OR v_to-v_from>366))
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  query:=lower(btrim(query));
  IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  IF p_input->'buildingId'<>'null'::jsonb THEN requested_building:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR session.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
    SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
  state:=app_private.hermes_domain_grant_v2(c.organization_id,permission,enabled,context);
  IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  -- Saved scope IDs map to buildings of the current organization only, then
  -- intersect the permission-specific CRM set. A cashbook scope grants none.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND state->'buildingIds' ? b.id::text
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
      AND scope.cashbook_id IS NULL AND (
      scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
      OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
        ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
        WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
  IF requested_building IS NOT NULL THEN
    IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested_building];
  END IF;
  buildings:=COALESCE(buildings,'{}'::uuid[]);
  -- Web parity (20261021170452; income_expenses only, its grant keeps the key scope): the web shows a voucher of a building in
  -- its buildings.view set (income_expenses_select_rbac) or, in any building, of a cashbook the asker holds
  -- (income_expenses_select_fund_member: account/change/rounding account IN accessible_account_ids()).
  IF p_domain='income_expenses' THEN
    v_web:=app_private.hermes_web_building_ids_v1(c.organization_id);
    v_accounts:=COALESCE(ARRAY(SELECT public.accessible_account_ids()),'{}'::uuid[]);
  END IF;

  -- Each branch: the page (cursor, LIMIT row_limit+1) and then the summary of the whole
  -- filtered set (same WHERE without cursor_id, no LIMIT).
  IF p_domain='income_expenses' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT ie.id,jsonb_build_object('id',ie.id,'code',app_private.hermes_domain_text_v1(ie.code),'type',ie.type,
        'name',app_private.hermes_domain_text_v1(COALESCE(ie.name,'')),'buildingId',ie.building_id,
        'buildingName',CASE WHEN ie.building_id=ANY(v_web) THEN app_private.hermes_domain_text_v1(COALESCE(building.name,'')) ELSE '' END,
        'roomId',CASE WHEN ie.building_id=ANY(v_web) THEN room.id END,
        'roomName',CASE WHEN ie.building_id=ANY(v_web) THEN app_private.hermes_domain_text_v1(room.name) END,'voucherDate',ie.voucher_date,
        'totalAmount',COALESCE(ie.total_amount,0)::text,'approvalStatus',ie.approval_status) item
      FROM public.income_expenses ie LEFT JOIN public.rooms room ON room.id=ie.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=ie.building_id
      LEFT JOIN public.buildings building ON building.id=ie.building_id AND building.organization_id=c.organization_id
      WHERE ie.organization_id=c.organization_id AND ie.deleted_at IS NULL AND ie.building_id=ANY(buildings)
        AND (ie.building_id=ANY(v_web) OR ie.account_id=ANY(v_accounts) OR ie.change_account_id=ANY(v_accounts) OR ie.rounding_account_id=ANY(v_accounts))
        AND ie.type IN ('INCOME','EXPENSE') AND NOT COALESCE(ie.has_restricted_item,true)
        AND ie.salary_staff_id IS NULL AND ie.shareholder_id IS NULL AND ie.profit_manager_id IS NULL
        AND (cursor_id IS NULL OR ie.id>cursor_id) AND (v_status IS NULL OR ie.approval_status=v_status)
        AND (v_from IS NULL OR ie.voucher_date>=v_from) AND (v_to IS NULL OR ie.voucher_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(ie.name,'')||' '||COALESCE(ie.code,'')))>0)
      ORDER BY ie.id LIMIT row_limit+1) found;
    -- Money (sum, byType, largest) excludes CANCELLED vouchers; count/byStatus keep them.
    v_summary:=(WITH f AS (
        SELECT ie.id,ie.code,ie.name,ie.type,ie.approval_status,COALESCE(ie.total_amount,0) total_amount,ie.voucher_date
        FROM public.income_expenses ie
        WHERE ie.organization_id=c.organization_id AND ie.deleted_at IS NULL AND ie.building_id=ANY(buildings)
          AND (ie.building_id=ANY(v_web) OR ie.account_id=ANY(v_accounts) OR ie.change_account_id=ANY(v_accounts) OR ie.rounding_account_id=ANY(v_accounts))
          AND ie.type IN ('INCOME','EXPENSE') AND NOT COALESCE(ie.has_restricted_item,true)
          AND ie.salary_staff_id IS NULL AND ie.shareholder_id IS NULL AND ie.profit_manager_id IS NULL
          AND (v_status IS NULL OR ie.approval_status=v_status)
          AND (v_from IS NULL OR ie.voucher_date>=v_from) AND (v_to IS NULL OR ie.voucher_date<=v_to)
          AND (query='' OR position(query IN lower(COALESCE(ie.name,'')||' '||COALESCE(ie.code,'')))>0)
      ), live AS (SELECT * FROM f WHERE f.approval_status IS DISTINCT FROM 'CANCELLED')
      SELECT jsonb_build_object('count',(SELECT count(*) FROM f),
        'byStatus',COALESCE((SELECT jsonb_object_agg(s.approval_status,s.n) FROM (SELECT f.approval_status,count(*) n FROM f WHERE f.approval_status IS NOT NULL GROUP BY 1) s),'{}'::jsonb),
        'sum',jsonb_build_object('totalAmount',COALESCE((SELECT sum(live.total_amount) FROM live),0)::text),
        -- R2c: every type also names its largest live voucher (shape and order of `largest` below: amount desc, then id).
        'byType',COALESCE((SELECT jsonb_object_agg(t.type,jsonb_build_object('count',t.n,'sum',t.amount::text,'largest',(SELECT jsonb_build_object(
            'id',big.id,'code',app_private.hermes_domain_text_v1(big.code),'name',app_private.hermes_domain_text_v1(COALESCE(big.name,'')),'type',big.type,
            'totalAmount',big.total_amount::text,'voucherDate',big.voucher_date) FROM live big WHERE big.type=t.type ORDER BY big.total_amount DESC,big.id LIMIT 1)))
          FROM (SELECT live.type,count(*) n,sum(live.total_amount) amount FROM live GROUP BY 1) t),'{}'::jsonb),
        'largest',(SELECT jsonb_build_object('id',live.id,'code',app_private.hermes_domain_text_v1(live.code),
          'name',app_private.hermes_domain_text_v1(COALESCE(live.name,'')),'type',live.type,'totalAmount',live.total_amount::text,'voucherDate',live.voucher_date)
          FROM live ORDER BY live.total_amount DESC,live.id LIMIT 1)));
  ELSIF p_domain='receivables' THEN
    -- B5c: the building of the room names each debt; a soft-deleted building
    -- still names a listed invoice (the scope above already excludes it).
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),
        'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),'buildingCode',app_private.hermes_domain_text_v1(building.code),
        'billingMonth',app_private.hermes_domain_text_v1(invoice.billing_month),'dueDate',invoice.due_date,
        'totalAmount',COALESCE(invoice.total_amount,0)::text,'paidAmount',COALESCE(invoice.paid_amount,0)::text,
        'remainingAmount',invoice.remaining_amount::text) item
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
        AND room.building_id=ANY(buildings) AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
        AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)
        AND (cursor_id IS NULL OR invoice.id>cursor_id)
        AND (v_from IS NULL OR invoice.due_date>=v_from) AND (v_to IS NULL OR invoice.due_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0)
      ORDER BY invoice.id LIMIT row_limit+1) found;
    -- Same summary as the fast reader (text through hermes_domain_text_v1 here, hermes_read_text_v1 there).
    v_summary:=(WITH debt AS (
        SELECT invoice.status::text status,room.building_id,building.name building_name,invoice.total_amount,invoice.paid_amount,invoice.remaining_amount
        FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
        LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
        WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
          AND room.building_id=ANY(buildings) AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
          AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)
          AND (v_from IS NULL OR invoice.due_date>=v_from) AND (v_to IS NULL OR invoice.due_date<=v_to)
          AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0))
      SELECT jsonb_build_object('count',(SELECT count(*) FROM debt),
        'byStatus',COALESCE((SELECT jsonb_object_agg(s.status,s.n) FROM (SELECT debt.status,count(*) n FROM debt GROUP BY 1) s),'{}'::jsonb),
        'sum',jsonb_build_object('totalAmount',COALESCE((SELECT sum(debt.total_amount) FROM debt),0)::text,'paidAmount',COALESCE((SELECT sum(debt.paid_amount) FROM debt),0)::text,
          'remainingAmount',COALESCE((SELECT sum(debt.remaining_amount) FROM debt),0)::text),
        'byBuilding',COALESCE((SELECT jsonb_agg(jsonb_build_object('buildingId',b.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(b.name,'')),
            'count',b.n,'remainingAmount',b.rem::text) ORDER BY b.rem DESC,b.building_id)
          FROM (SELECT debt.building_id,max(debt.building_name) name,count(*) n,sum(debt.remaining_amount) rem FROM debt GROUP BY 1 ORDER BY rem DESC,debt.building_id LIMIT 50) b),'[]'::jsonb)));
  ELSIF p_domain='meter_readings' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT reading.id,jsonb_build_object('id',reading.id,'code',app_private.hermes_domain_text_v1(reading.reading_code),
        'buildingId',reading.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),
        'meterType',reading.meter_type,'settlementMonth',app_private.hermes_domain_text_v1(reading.settlement_month),
        'readingDate',reading.reading_date,'previousReading',COALESCE(reading.previous_reading,0)::text,
        'currentReading',reading.current_reading::text,'consumption',reading.consumption::text,'status',reading.status) item
      FROM public.meter_readings reading LEFT JOIN public.rooms room ON room.id=reading.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=reading.building_id
      LEFT JOIN public.buildings building ON building.id=reading.building_id AND building.organization_id=c.organization_id
      WHERE reading.organization_id=c.organization_id AND reading.deleted_at IS NULL AND reading.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR reading.id>cursor_id) AND (v_status IS NULL OR reading.status=v_status)
        AND (v_from IS NULL OR reading.reading_date>=v_from) AND (v_to IS NULL OR reading.reading_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(reading.reading_code,'')||' '||COALESCE(room.name,'')))>0)
      ORDER BY reading.id LIMIT row_limit+1) found;
    -- rooms: distinct live rooms of the listed readings (the roomId the rows carry).
    v_summary:=(WITH r AS (
        SELECT room.id room_id,reading.meter_type,reading.status,reading.consumption
        FROM public.meter_readings reading LEFT JOIN public.rooms room ON room.id=reading.room_id AND room.organization_id=c.organization_id
          AND room.deleted_at IS NULL AND room.building_id=reading.building_id
        WHERE reading.organization_id=c.organization_id AND reading.deleted_at IS NULL AND reading.building_id=ANY(buildings)
          AND (v_status IS NULL OR reading.status=v_status)
          AND (v_from IS NULL OR reading.reading_date>=v_from) AND (v_to IS NULL OR reading.reading_date<=v_to)
          AND (query='' OR position(query IN lower(COALESCE(reading.reading_code,'')||' '||COALESCE(room.name,'')))>0))
      SELECT jsonb_build_object('count',(SELECT count(*) FROM r),
        'byStatus',COALESCE((SELECT jsonb_object_agg(s.status,s.n) FROM (SELECT r.status,count(*) n FROM r WHERE r.status IS NOT NULL GROUP BY 1) s),'{}'::jsonb),
        'sum',jsonb_build_object('consumption',COALESCE((SELECT sum(r.consumption) FROM r),0)::text),
        'byType',COALESCE((SELECT jsonb_object_agg(t.meter_type,t.n) FROM (SELECT r.meter_type,count(*) n FROM r WHERE r.meter_type IS NOT NULL GROUP BY 1) t),'{}'::jsonb),
        'rooms',(SELECT count(DISTINCT r.room_id) FROM r)));
  ELSIF p_domain='deposits_held' THEN
    -- Canonical held-deposit report; an empty array selects no building.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT summary.building_id id,jsonb_build_object('id',summary.building_id,'buildingId',summary.building_id,
        'name',app_private.hermes_domain_text_v1(COALESCE(summary.building_name,'')),'contractCount',summary.contract_count,
        'expected',COALESCE(summary.expected,0)::text,'held',COALESCE(summary.held,0)::text,
        'shortfallAll',COALESCE(summary.shortfall_all,0)::text,'shortfallShort',COALESCE(summary.shortfall_short,0)::text,
        'fullCount',summary.full_count,'shortCount',summary.short_count,'firstInvoiceCount',summary.first_invoice_count) item
      FROM public.get_held_deposit_summary(buildings) summary
      WHERE summary.building_id=ANY(buildings) AND (cursor_id IS NULL OR summary.building_id>cursor_id)
        AND (query='' OR position(query IN lower(COALESCE(summary.building_name,'')))>0)
      ORDER BY summary.building_id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'sum',jsonb_build_object('expected',COALESCE(sum(COALESCE(held.expected,0)),0)::text,
        'held',COALESCE(sum(COALESCE(held.held,0)),0)::text,'shortfallAll',COALESCE(sum(COALESCE(held.shortfall_all,0)),0)::text),
        'contractCount',COALESCE(sum(held.contract_count),0)::bigint,'fullCount',COALESCE(sum(held.full_count),0)::bigint,
        'shortCount',COALESCE(sum(held.short_count),0)::bigint) INTO v_summary
      FROM public.get_held_deposit_summary(buildings) held
      WHERE held.building_id=ANY(buildings) AND (query='' OR position(query IN lower(COALESCE(held.building_name,'')))>0);
  ELSE
    -- Canonical P&L (approved vouchers, kqkd_amount by voucher_date), summed by
    -- building over the requested period. Buildings without data are absent.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT pnl.building_id id,jsonb_build_object('id',pnl.building_id,'buildingId',pnl.building_id,
        'name',app_private.hermes_domain_text_v1(COALESCE(max(pnl.building_name),'')),'revenue',COALESCE(sum(pnl.revenue),0)::text,
        'expense',COALESCE(sum(pnl.expense),0)::text,'net',COALESCE(sum(pnl.net),0)::text,'months',count(*)) item
      FROM public.fa_monthly_pnl(v_from,v_to,buildings) pnl
      WHERE pnl.building_id=ANY(buildings) AND (cursor_id IS NULL OR pnl.building_id>cursor_id)
      GROUP BY pnl.building_id
      HAVING query='' OR position(query IN lower(COALESCE(max(pnl.building_name),'')))>0
      ORDER BY pnl.building_id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'sum',jsonb_build_object('revenue',COALESCE(sum(t.revenue),0)::text,
        'expense',COALESCE(sum(t.expense),0)::text,'net',COALESCE(sum(t.net),0)::text)) INTO v_summary FROM (
      SELECT pnl.building_id,COALESCE(sum(pnl.revenue),0) revenue,COALESCE(sum(pnl.expense),0) expense,COALESCE(sum(pnl.net),0) net
      FROM public.fa_monthly_pnl(v_from,v_to,buildings) pnl
      WHERE pnl.building_id=ANY(buildings)
      GROUP BY pnl.building_id
      HAVING query='' OR position(query IN lower(COALESCE(max(pnl.building_name),'')))>0) t;
  END IF;
  IF jsonb_array_length(rows)>row_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
    next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
  END IF;
  IF octet_length(rows::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor,'summary',v_summary,
    'source',v_source,'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $fn$;

ALTER FUNCTION app_private.hermes_web_building_ids_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_capabilities_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record;
BEGIN
  FOR p IN SELECT x.sig,x.new_md5,q.oid,q.prosrc,q.prosecdef,q.provolatile,pg_get_userbyid(q.proowner) owner,
      replace(COALESCE(array_to_string(q.proconfig,','),''),'"','') cfg,x.vol,x.caller
    FROM (VALUES ('app_private.hermes_web_building_ids_v1(uuid)','b2d79a218e3f389295151ca9a10c6ce5','s',false),
      ('public.hermes_domain_capabilities_v1(uuid)','256a0f6d21e930249b39e6d2cdd56f63','s',true),
      ('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)','39514ae1eda3dc2baaea20eb5b4ae537','v',false),
      ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','39514ae1eda3dc2baaea20eb5b4ae537','s',false),
      ('app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)','a666f5cbd6ab7d87031616c30fb3bac0','v',false),
      ('public.hermes_domain_read_v2(jsonb,text,jsonb)','32f362d61c2861696e56ef355372b7d4','v',true)) x(sig,new_md5,vol,caller)
    LEFT JOIN pg_proc q ON q.oid=to_regprocedure(x.sig) LOOP
    IF p.oid IS NULL OR NOT p.prosecdef OR p.provolatile<>p.vol OR p.owner<>'postgres' OR p.cfg<>'search_path=pg_catalog, public, app_private'
      OR md5(replace(p.prosrc,chr(13),''))<>p.new_md5
      OR has_function_privilege('authenticated',p.sig,'EXECUTE') IS DISTINCT FROM p.caller
      OR has_function_privilege('anon',p.sig,'EXECUTE') OR has_function_privilege('service_role',p.sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',p.sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_web_building_scope_contract_violated: %',p.sig; END IF;
  END LOOP;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
