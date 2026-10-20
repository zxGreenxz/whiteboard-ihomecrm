-- B2 (20/10/2026): crm_read_receivables joins the fixed private read plan.
-- The admission maps receivables to invoices.view and accepts the seven family
-- v2 input keys (fromDate/toDate validated like hermes_domain_read_v2). The
-- shared INVOKER reader gains a receivables branch with the same meaning as the
-- receivables branch of hermes_domain_read_v2 — same status set, remaining>0,
-- due_date range, literal query, UUID keyset order, limit+1 cursor — but reads
-- invoices/rooms under the asker's RLS (never wider than v2) and returns
-- source/fetchedAt like v2. No signature changes; the public wrapper
-- hermes_domain_read_fast_v1 (20261019040111) is untouched. Candidate only:
-- readFastPath stays off until the application opts in.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_date_v2(jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_fast_read_dependency_invalid: hermes_domain_date_v2'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_read_text_v1(text)');
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_fast_read_dependency_invalid: hermes_read_text_v1'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_fast_read_requires_applied_admission_v1'; END IF;
  SELECT q.prosecdef,q.provolatile,q.proowner,q.prosqlbody INTO p FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='app_private' AND q.proname='hermes_domain_read_rows_fast_v1';
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosqlbody IS NULL
    THEN RAISE EXCEPTION 'hermes_fast_read_requires_shared_invoker_reader'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_domain_read_scope_fast_v1(p_binding jsonb,p_domain text,p_input jsonb,p_caller text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; enabled boolean;
  selected uuid[]; buildings uuid[]; customer_buildings uuid[]:='{}'; contract_buildings uuid[]:='{}';
  overlay_org boolean; org_wide boolean; requested uuid; cursor_id uuid; row_limit integer; query text; status text;
  v_from date; v_to date; result jsonb; scope_sets jsonb:='{}'; grant_state jsonb;
BEGIN
  IF p_caller IS DISTINCT FROM 'authenticated' OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  permission:=CASE p_domain WHEN 'customers' THEN 'customers.view' WHEN 'contracts' THEN 'contracts.view' WHEN 'invoices' THEN 'invoices.view'
    WHEN 'receivables' THEN 'invoices.view' END;
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedSessionRevision']);
  -- Family v2 input (receivables) carries fromDate/toDate; the v1 shape stays exact for the other domains.
  PERFORM app_private.hermes_request_v1(p_input,CASE WHEN p_domain='receivables'
    THEN ARRAY['query','limit','cursor','buildingId','status','fromDate','toDate'] ELSE ARRAY['query','limit','cursor','buildingId','status'] END);
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  IF jsonb_typeof(p_binding->'tokenDigest') IS DISTINCT FROM 'string' OR (p_binding->>'tokenDigest') !~ '^[a-f0-9]{64}$'
    OR app_private.hermes_integer_v1(p_binding->'expectedEpoch')<1 OR app_private.hermes_integer_v1(p_binding->'expectedSessionRevision')<1
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  row_limit:=app_private.hermes_integer_v1(p_input->'limit'); query:=p_input->>'query'; status:=p_input->>'status';
  IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
    OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
    OR (p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR NOT (
      (p_domain='contracts' AND status IN ('DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED')) OR
      (p_domain='receivables' AND status IN ('APPROVED','PARTIAL_PAID','OVERDUE')))))
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_domain='receivables' THEN
    v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate'); v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
    IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_to<v_from THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  IF p_input->'buildingId'<>'null'::jsonb THEN requested:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;

  -- A single statement snapshot admits the read. Do not reuse a writer helper:
  -- that would lock the organization and revalidate after the business query.
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_binding->>'tokenDigest';
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id;
  IF c.id IS NULL OR s.id IS NULL OR t.token_digest IS NULL OR a.id IS NULL
    OR c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR a.state<>'ACTIVE'
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=now()
    OR s.user_id IS DISTINCT FROM c.user_id OR s.organization_id IS DISTINCT FROM c.organization_id OR s.assistant_id IS DISTINCT FROM c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR t.revoked_at IS NOT NULL OR t.expires_at<=now() OR t.created_at>now() OR t.created_at+interval '30 days'<=now()
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  IF c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch' OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  member:=app_private.hermes_metadata_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO selected FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) intersection;
  overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(selected) AND scope.organization_id=c.organization_id
    AND scope.scope_type='ORGANIZATION' AND scope.cashbook_id IS NULL);

  -- Only the requested permission and its two possible embeds are evaluated;
  -- each embed retains its own CRM grant and explicit Hermes exclusion.
  FOREACH k IN ARRAY ARRAY[permission,'customers.view','contracts.view'] LOOP
    IF scope_sets ? k THEN CONTINUE; END IF;
    enabled:=COALESCE(policy.enabled,false) AND k=ANY(policy.read_capabilities) AND k=ANY(c.read_capabilities)
      AND NOT(k=ANY(c.excluded_read)) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=k AND h.mode='read' AND h.enabled);
    grant_state:=app_private.hermes_metadata_domain_grant_v1(c.organization_id,k,enabled,context);
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
      WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL AND grant_state->'buildingIds' ? b.id::text
        AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(selected) AND scope.organization_id=c.organization_id
          AND scope.cashbook_id IS NULL AND (scope.scope_type='ORGANIZATION' OR scope.scope_type='BUILDING' AND scope.building_id=b.id
            OR scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas ar
              ON ar.id=ab.area_id AND ar.organization_id=ab.organization_id AND ar.deleted_at IS NULL
              WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id)));
    scope_sets:=scope_sets||jsonb_build_object(k,jsonb_build_object('buildingIds',buildings,'allowed',grant_state->'allowed',
      'orgWide',COALESCE(grant_state->'orgWide'='true'::jsonb,false) AND overlay_org));
  END LOOP;
  state:=scope_sets->permission;
  IF state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO buildings FROM jsonb_array_elements_text(state->'buildingIds') v;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO customer_buildings FROM jsonb_array_elements_text(scope_sets#>'{customers.view,buildingIds}') v;
  SELECT COALESCE(array_agg(v::uuid),'{}'::uuid[]) INTO contract_buildings FROM jsonb_array_elements_text(scope_sets#>'{contracts.view,buildingIds}') v;
  org_wide:=state->'orgWide'='true'::jsonb;
  IF requested IS NOT NULL THEN
    IF NOT(requested=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested]; org_wide:=false;
  END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'connectionId',c.id,'permission',permission,
    'buildingIds',buildings,'cashbookIds','[]'::jsonb,'customerBuildingIds',customer_buildings,'contractBuildingIds',contract_buildings,
    'orgWide',org_wide,'query',btrim(query),'limit',row_limit,'cursor',cursor_id,'buildingId',requested,'status',status,
    'fromDate',v_from,'toDate',v_to,
    'domain',p_domain,'fetchedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $fn$;

-- Parsed SQL body binds helper OIDs at creation. Business rows remain INVOKER:
-- never execute this reader from a SECURITY DEFINER broker/adapter. The
-- receivables branch is the Hermes-owned v2 meaning (no web page to mirror),
-- read through the asker's RLS on invoices and rooms.
CREATE OR REPLACE FUNCTION app_private.hermes_domain_read_rows_fast_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
BEGIN ATOMIC
 WITH plan AS MATERIALIZED (
  SELECT p_plan p WHERE current_user='authenticated' AND p_plan->>'userId'=auth.uid()::text
 ), source AS MATERIALIZED (
  SELECT p,CASE p->>'domain'
   WHEN 'customers' THEN public.customer_list_core_v1(
    p_organization_id=>(p->>'organizationId')::uuid,p_search=>p->>'query',
    p_building_ids=>CASE WHEN (p->>'orgWide')::boolean THEN NULL ELSE ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x) END,
    p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_include_location=>jsonb_array_length(p->'contractBuildingIds')>0,
    p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,
    p_location_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'contractBuildingIds') x))
   WHEN 'contracts' THEN public.contract_list_core_v1(
    p_search=>p->>'query',p_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x),
    p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_with_customers=>jsonb_array_length(p->'customerBuildingIds')>0,
    p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,p_exact_status=>p->>'status',
    p_customer_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'customerBuildingIds') x),p_organization_id=>(p->>'organizationId')::uuid)
   WHEN 'invoices' THEN public.invoice_list_core_v1(
    p_view_status=>'all',p_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x),
    p_search=>p->>'query',p_limit=>(p->>'limit')::integer+1,p_offset=>0,p_order=>'id_asc',p_after_id=>(p->>'cursor')::uuid,
    p_customer_building_ids=>ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'customerBuildingIds') x),p_organization_id=>(p->>'organizationId')::uuid)
   WHEN 'receivables' THEN (SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(found) ORDER BY found.id),'[]'::jsonb)) FROM (
    SELECT invoice.id,invoice.invoice_number,invoice.status,room.building_id,room.id AS room_id,room.name AS room_name,invoice.billing_month,
     invoice.due_date,invoice.total_amount,invoice.paid_amount,invoice.remaining_amount
    FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=(p->>'organizationId')::uuid AND room.deleted_at IS NULL
    WHERE invoice.organization_id=(p->>'organizationId')::uuid AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
     AND room.building_id=ANY(ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x))
     AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND invoice.remaining_amount>0
     AND (p->>'status' IS NULL OR invoice.status::text=p->>'status') AND (p->>'cursor' IS NULL OR invoice.id>(p->>'cursor')::uuid)
     AND (p->>'fromDate' IS NULL OR invoice.due_date>=(p->>'fromDate')::date) AND (p->>'toDate' IS NULL OR invoice.due_date<=(p->>'toDate')::date)
     AND (p->>'query'='' OR position(lower(p->>'query') IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0)
    ORDER BY invoice.id LIMIT (p->>'limit')::integer+1) found) END data
  FROM plan
 ), projected AS MATERIALIZED (
  SELECT p,e->>'id' id,CASE p->>'domain'
   WHEN 'customers' THEN jsonb_build_object('id',e->'id','name',public.hermes_read_text_v1(COALESCE(e->>'full_name','')),
    'phone',public.hermes_read_text_v1(e->>'phone'),'contractId',e->'hermes_contract_id','buildingId',e->'current_building_id',
    'roomId',e->'hermes_room_id','roomName',public.hermes_read_text_v1(e->>'current_room_name'))
   WHEN 'contracts' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'contract_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e#>'{room,building_id}','roomId',e->'room_id','startDate',e->'start_date','endDate',e->'end_date')
   WHEN 'invoices' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e->'building_id','roomId',e->'room_id',
    'billingMonth',public.hermes_read_text_v1(e->>'billing_month'),'totalAmount',COALESCE((e->>'total_amount')::numeric,0)::text)
   WHEN 'receivables' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),'status',e->'status',
    'buildingId',e->'building_id','roomId',e->'room_id','roomName',public.hermes_read_text_v1(e->>'room_name'),
    'billingMonth',public.hermes_read_text_v1(e->>'billing_month'),'dueDate',e->'due_date',
    'totalAmount',COALESCE((e->>'total_amount')::numeric,0)::text,'paidAmount',COALESCE((e->>'paid_amount')::numeric,0)::text,
    'remainingAmount',(e->>'remaining_amount')::numeric::text) END item
  FROM source CROSS JOIN LATERAL jsonb_array_elements(data->'rows') e
  WHERE p->>'domain' IN ('customers','receivables') OR p->>'domain'='invoices' AND e->>'room_id' IS NOT NULL OR e#>>'{room,id}' IS NOT NULL
 ), result AS (
  SELECT p,jsonb_build_object('organizationId',p->'organizationId','domain',p->>'domain',
   'items',COALESCE((SELECT jsonb_agg(item ORDER BY id) FROM (SELECT item,id FROM projected ORDER BY id LIMIT (p_plan->>'limit')::integer) page),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM projected)>(p->>'limit')::integer
    THEN (SELECT to_jsonb(id) FROM projected ORDER BY id OFFSET (p_plan->>'limit')::integer-1 LIMIT 1) ELSE 'null'::jsonb END)
   || CASE p->>'domain' WHEN 'customers' THEN jsonb_build_object('fetchedAt',p->'fetchedAt')
    WHEN 'receivables' THEN jsonb_build_object('source','crm.invoices','fetchedAt',p->'fetchedAt') ELSE '{}'::jsonb END value FROM plan
 ) SELECT value FROM result;
END;

ALTER FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text),app_private.hermes_domain_read_rows_fast_v1(jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)',
    'app_private.hermes_domain_read_rows_fast_v1(jsonb)','public.hermes_domain_read_fast_v1(jsonb,text,jsonb)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
      OR p.prosecdef IS DISTINCT FROM (sig LIKE 'app_private.hermes_domain_read_scope_fast_v1%')
      OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
      OR has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_fast_read_receivables_contract_violated: %',sig; END IF;
  END LOOP;
  -- The invoker reader keeps its parsed body and empty search_path (stored as
  -- search_path=""): helper OIDs are bound at creation and no name is ever
  -- resolved as the asker.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_rows_fast_v1(jsonb)');
  IF p.prosqlbody IS NULL OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path='
    THEN RAISE EXCEPTION 'hermes_fast_read_receivables_reader_path_changed'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
