-- R2d REVERT — prepared 21/10/2026 next to the forward file; NOT a migration (docs/plans/hermes-crm/revert/).
-- Returns the two functions 20261021063452_hermes_domain_without_contract_latest_count_v1.sql replaced to their exact
-- 20261021044801 (R2c part 2) bodies — app_private.hermes_domain_read_rows_fast_v1 (customers summary without
-- withoutContract) and public.hermes_domain_read_v1 (assets summary without latestCount; services back to the rule that
-- hides a service whose only active links point to soft-deleted buildings) — then drops the helper the forward file
-- created, app_private.hermes_customers_without_contract_v1 (no body binds it any more). Signatures and the ACL of the two
-- readers unchanged.
-- SAFE ORDER: the running connector must accept summaries without withoutContract/latestCount — the R2d connector does
-- (its one-release window, DOMAIN_SUMMARY_KEY_TOLERANT); the release after it (window closed) refuses them.
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs
-- hermes_domain_without_contract_latest_count_revert_v1` gives; pin the reader in scripts/hermes-read-function-specs.mjs
-- and the forward pins (live → the new file, 20261021063452 → FORWARD_SUPERSEDED; the helper leaves FORWARD_FUNCTIONS and
-- the authenticated allowlist of scripts/__tests__/hermes-durable-schema.test.mjs); TEST lane, then production. Revert the
-- wave-2 twin with hermes_w2_customers_without_contract_revert_v1.sql.
-- Before hermes_domain_customer_status_asset_created_revert_v1.sql (R2c part 2) when both are needed: that artifact
-- refuses to run while this file's bodies are live.
-- $requires$ refuses to run over other bodies; idempotent (CREATE OR REPLACE, DROP FUNCTION IF EXISTS).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR (length(p.prosrc)-length(replace(p.prosrc,'INTO v_summary','')))/length('INTO v_summary')<>8
    OR position('v_summary:=v_summary||jsonb_build_object(''latest''' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_without_contract_revert_unexpected_v1'; END IF;
  SELECT q.oid,q.prosecdef,q.provolatile,q.proowner,q.prosqlbody INTO p FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='app_private' AND q.proname='hermes_domain_read_rows_fast_v1';
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosqlbody IS NULL
    OR position('total_count' IN pg_get_function_sqlbody(p.oid))=0 OR position('status_v2' IN pg_get_function_sqlbody(p.oid))=0
    THEN RAISE EXCEPTION 'hermes_without_contract_revert_unexpected_reader'; END IF;
END $requires$;

-- The 20261021044801 bodies, verbatim.
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
   WHEN 'receivables' THEN (SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(found) ORDER BY found.id),'[]'::jsonb),
    'summary',(WITH debt AS (
     SELECT invoice.status::text AS status,room.building_id,building.name AS building_name,invoice.total_amount,invoice.paid_amount,invoice.remaining_amount
     FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=(p->>'organizationId')::uuid AND room.deleted_at IS NULL
     LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=(p->>'organizationId')::uuid
     WHERE invoice.organization_id=(p->>'organizationId')::uuid AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
      AND room.building_id=ANY(ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x))
      AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND invoice.remaining_amount>0
      AND (p->>'status' IS NULL OR invoice.status::text=p->>'status')
      AND (p->>'fromDate' IS NULL OR invoice.due_date>=(p->>'fromDate')::date) AND (p->>'toDate' IS NULL OR invoice.due_date<=(p->>'toDate')::date)
      AND (p->>'query'='' OR position(lower(p->>'query') IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0))
     SELECT jsonb_build_object('count',(SELECT count(*) FROM debt),
      'byStatus',COALESCE((SELECT jsonb_object_agg(s.status,s.n) FROM (SELECT debt.status,count(*) AS n FROM debt GROUP BY 1) s),'{}'::jsonb),
      'sum',jsonb_build_object('totalAmount',COALESCE((SELECT sum(debt.total_amount) FROM debt),0)::text,'paidAmount',COALESCE((SELECT sum(debt.paid_amount) FROM debt),0)::text,
       'remainingAmount',COALESCE((SELECT sum(debt.remaining_amount) FROM debt),0)::text),
      'byBuilding',COALESCE((SELECT jsonb_agg(jsonb_build_object('buildingId',b.building_id,'buildingName',public.hermes_read_text_v1(COALESCE(b.name,'')),
        'count',b.n,'remainingAmount',b.rem::text) ORDER BY b.rem DESC,b.building_id)
       FROM (SELECT debt.building_id,max(debt.building_name) AS name,count(*) AS n,sum(debt.remaining_amount) AS rem FROM debt GROUP BY 1 ORDER BY rem DESC,debt.building_id LIMIT 50) b),'[]'::jsonb)))) FROM (
    SELECT invoice.id,invoice.invoice_number,invoice.status,room.building_id,room.id AS room_id,room.name AS room_name,
     building.name AS building_name,building.code AS building_code,invoice.billing_month,
     invoice.due_date,invoice.total_amount,invoice.paid_amount,invoice.remaining_amount
    FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=(p->>'organizationId')::uuid AND room.deleted_at IS NULL
    LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=(p->>'organizationId')::uuid
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
    'buildingName',public.hermes_read_text_v1(COALESCE(e->>'current_building_name','')),
    'roomId',e->'hermes_room_id','roomName',public.hermes_read_text_v1(e->>'current_room_name'))
   WHEN 'contracts' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'contract_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e#>'{room,building_id}','buildingName',public.hermes_read_text_v1(COALESCE(e#>>'{room,building,name}','')),
    'roomId',e->'room_id','roomName',public.hermes_read_text_v1(e#>>'{room,name}'),'startDate',e->'start_date','endDate',e->'end_date')
   WHEN 'invoices' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e->'building_id',
    'buildingName',public.hermes_read_text_v1(COALESCE((SELECT b.name FROM public.buildings b WHERE b.id=(e->>'building_id')::uuid AND b.organization_id=(p->>'organizationId')::uuid),'')),
    'roomId',e->'room_id','roomName',public.hermes_read_text_v1((SELECT r.name FROM public.rooms r WHERE r.id=(e->>'room_id')::uuid AND r.organization_id=(p->>'organizationId')::uuid)),
    'billingMonth',public.hermes_read_text_v1(e->>'billing_month'),'totalAmount',COALESCE((e->>'total_amount')::numeric,0)::text)
   WHEN 'receivables' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),'status',e->'status',
    'buildingId',e->'building_id','roomId',e->'room_id','roomName',public.hermes_read_text_v1(e->>'room_name'),
    'buildingName',public.hermes_read_text_v1(COALESCE(e->>'building_name','')),'buildingCode',public.hermes_read_text_v1(e->>'building_code'),
    'billingMonth',public.hermes_read_text_v1(e->>'billing_month'),'dueDate',e->'due_date',
    'totalAmount',COALESCE((e->>'total_amount')::numeric,0)::text,'paidAmount',COALESCE((e->>'paid_amount')::numeric,0)::text,
    'remainingAmount',(e->>'remaining_amount')::numeric::text) END item
  FROM source CROSS JOIN LATERAL jsonb_array_elements(data->'rows') e
  WHERE p->>'domain' IN ('customers','receivables') OR p->>'domain'='invoices' AND e->>'room_id' IS NOT NULL OR e#>>'{room,id}' IS NOT NULL
 ), result AS (
  SELECT p,jsonb_build_object('organizationId',p->'organizationId','domain',p->>'domain',
   'items',COALESCE((SELECT jsonb_agg(item ORDER BY id) FROM (SELECT item,id FROM projected ORDER BY id LIMIT (p_plan->>'limit')::integer) page),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM projected)>(p->>'limit')::integer
    THEN (SELECT to_jsonb(id) FROM projected ORDER BY id OFFSET (p_plan->>'limit')::integer-1 LIMIT 1) ELSE 'null'::jsonb END,
   'summary',CASE p->>'domain'
    -- R2c: customers by contract status (customers.status_v2 = the tabs of /customers: RENTING đang thuê, MOVED_OUT đã
    -- chuyển đi, WALK_IN vãng lai/chưa có hợp đồng) over the core's set under the same RLS: the company's live customers,
    -- with the core's location filter (customer_location_ids_v1, history) unless Toàn tổ chức. With a query: null (the
    -- core's search patterns are not copied), like contracts.
    WHEN 'customers' THEN jsonb_build_object('count',data->'total',
     'byStatus',CASE WHEN p->>'query'='' THEN COALESCE((SELECT jsonb_object_agg(g.status,g.n) FROM (
       SELECT cu.status_v2::text AS status,count(*) AS n FROM public.customers cu
       WHERE cu.organization_id=(p->>'organizationId')::uuid AND cu.deleted_at IS NULL AND cu.status_v2 IS NOT NULL
        AND ((p->>'orgWide')::boolean OR cu.id=ANY((SELECT public.customer_location_ids_v1((p->>'organizationId')::uuid,
         ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x),NULL::uuid,true))::uuid[]))
       GROUP BY 1) g),'{}'::jsonb) ELSE 'null'::jsonb END,
     'sum','{}'::jsonb)
    WHEN 'invoices' THEN jsonb_build_object('count',data->'total_count','byStatus','{}'::jsonb,'sum','{}'::jsonb)
    WHEN 'contracts' THEN jsonb_build_object('count',data->'total',
     'byStatus',CASE WHEN p->>'query'='' THEN COALESCE((SELECT jsonb_object_agg(g.status,g.n) FROM (
       SELECT c.status::text AS status,count(*) AS n FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id
       WHERE c.deleted_at IS NULL AND c.organization_id=(p->>'organizationId')::uuid AND (p->>'status' IS NULL OR c.status::text=p->>'status')
        AND r.building_id=ANY(ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x)) GROUP BY 1) g),'{}'::jsonb) ELSE 'null'::jsonb END,
     'sum','{}'::jsonb)
    ELSE data->'summary' END)
   || CASE p->>'domain' WHEN 'customers' THEN jsonb_build_object('fetchedAt',p->'fetchedAt')
    WHEN 'receivables' THEN jsonb_build_object('source','crm.invoices','fetchedAt',p->'fetchedAt') ELSE '{}'::jsonb END value FROM source
 ) SELECT value FROM result;
END;

CREATE OR REPLACE FUNCTION public.hermes_domain_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; capabilities jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; org_wide boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; rows jsonb; next_cursor uuid; v_summary jsonb; v_tz text;
BEGIN
  permission:=app_private.hermes_domain_permission_v1(p_domain);
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
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
      (p_domain='leads' AND v_status IN ('B1_LEAD','B2_APPOINTMENT','B3_CONSULTATION','CONVERTED','FAILED')) OR
      (p_domain='contracts' AND v_status IN ('DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED')) OR
      (p_domain='tasks' AND v_status IN ('IN_PROGRESS','COMPLETED')))))
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
  capabilities:=public.hermes_domain_capabilities_v1(c.organization_id);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR capabilities->>'policyVersion' IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF capabilities->'permissions'->permission->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  -- Map saved scope IDs within the current organization, then intersect the
  -- permission-specific CRM building set. A cashbook scope grants no buildings.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND capabilities->'permissions'->permission->'buildingIds' ? b.id::text
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id AND (
      scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
      OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
        ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
        WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
  SELECT COALESCE(scope.org_wide,false) AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay
    WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION')
    INTO org_wide FROM app_private.authorized_scope_v3(permission,c.organization_id) scope;
  org_wide:=COALESCE(org_wide,false);
  IF requested_building IS NOT NULL THEN
    IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested_building]; org_wide:=false;
  END IF;

  -- Each branch: the page (cursor, LIMIT row_limit+1) and then the summary of the whole
  -- filtered set (same WHERE without cursor_id, no LIMIT). byStatus lists only present values.
  IF p_domain='customers' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phoneMasked',CASE WHEN customer.phone IS NULL THEN NULL ELSE '***'||right(regexp_replace(customer.phone,'[^0-9]','','g'),4) END,
        'contractId',latest.id,'buildingId',latest.building_id,'roomId',latest.room_id) item
      FROM public.customers customer JOIN LATERAL (
        SELECT contract.id,room.id room_id,room.building_id FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
        WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(contract.actual_end_date,contract.end_date) DESC NULLS LAST,contract.id LIMIT 1) latest ON true
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL AND (cursor_id IS NULL OR customer.id>cursor_id)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0 OR position(query IN COALESCE(customer.phone,''))>0)
      ORDER BY customer.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.customers customer
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM public.contract_customers cc
          JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
          JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
          WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0 OR position(query IN COALESCE(customer.phone,''))>0);
  ELSIF p_domain='leads' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT lead.id,jsonb_build_object('id',lead.id,'name',app_private.hermes_domain_text_v1(COALESCE(lead.customer_name,'')),
        'status',lead.status,'buildingId',lead.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'nextFollowUp',lead.next_follow_up_date) item
      FROM public.leads lead LEFT JOIN public.rooms room ON room.id=lead.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=lead.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=lead.building_id AND building.organization_id=c.organization_id
      WHERE lead.organization_id=c.organization_id AND lead.deleted_at IS NULL
        AND (lead.building_id=ANY(buildings) OR (lead.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR lead.id>cursor_id) AND (v_status IS NULL OR lead.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(lead.customer_name,'')))>0)
      ORDER BY lead.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),
        'sum','{}'::jsonb) INTO v_summary FROM (
      SELECT lead.status::text status,count(*) n FROM public.leads lead
      WHERE lead.organization_id=c.organization_id AND lead.deleted_at IS NULL
        AND (lead.building_id=ANY(buildings) OR (lead.building_id IS NULL AND org_wide))
        AND (v_status IS NULL OR lead.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(lead.customer_name,'')))>0)
      GROUP BY 1) s;
  ELSIF p_domain='contracts' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT contract.id,jsonb_build_object('id',contract.id,'number',app_private.hermes_domain_text_v1(contract.contract_number),
        'status',contract.status,'buildingId',room.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'startDate',contract.start_date,
        'endDate',COALESCE(contract.actual_end_date,contract.end_date)) item
      FROM public.contracts contract JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE contract.organization_id=c.organization_id AND contract.deleted_at IS NULL AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR contract.id>cursor_id) AND (v_status IS NULL OR contract.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(contract.contract_number,'')))>0)
      ORDER BY contract.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),
        'sum','{}'::jsonb) INTO v_summary FROM (
      SELECT contract.status::text status,count(*) n
      FROM public.contracts contract JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE contract.organization_id=c.organization_id AND contract.deleted_at IS NULL AND room.building_id=ANY(buildings)
        AND (v_status IS NULL OR contract.status::text=v_status)
        AND (query='' OR position(query IN lower(COALESCE(contract.contract_number,'')))>0)
      GROUP BY 1) s;
  ELSIF p_domain='invoices' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'billingMonth',invoice.billing_month,'totalAmount',COALESCE(invoice.total_amount,0)::text) item
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id AND room.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR invoice.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')))>0)
      ORDER BY invoice.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id AND room.building_id=ANY(buildings)
        AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')))>0);
  ELSIF p_domain='assets' THEN
    -- R2c: createdAt = the day the asset was added, in the company's business time zone (org_timezone_v1).
    v_tz:=app_private.org_timezone_v1(c.organization_id);
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT asset.id,jsonb_build_object('id',asset.id,'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),
        'code',app_private.hermes_domain_text_v1(asset.code),'condition',asset.condition,'buildingId',asset.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'quantity',COALESCE(asset.quantity,0)::text,
        'createdAt',(asset.created_at AT TIME ZONE v_tz)::date) item
      FROM public.assets asset LEFT JOIN public.rooms room ON room.id=asset.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=asset.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=asset.building_id AND building.organization_id=c.organization_id
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (cursor_id IS NULL OR asset.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      ORDER BY asset.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.condition,s.n) FILTER (WHERE s.condition IS NOT NULL),'{}'::jsonb),
        'sum',jsonb_build_object('quantity',COALESCE(sum(s.quantity),0)::text)) INTO v_summary FROM (
      SELECT asset.condition::text condition,count(*) n,sum(COALESCE(asset.quantity,0)) quantity FROM public.assets asset
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      GROUP BY 1) s;
    -- R2c: the most recently added asset of the same set (created_at desc, then id; no cursor, no LIMIT before it),
    -- named and dated like the rows; null when the set is empty.
    v_summary:=v_summary||jsonb_build_object('latest',(SELECT jsonb_build_object('id',asset.id,
        'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),'code',app_private.hermes_domain_text_v1(asset.code),
        'buildingId',asset.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomName',app_private.hermes_domain_text_v1(room.name),'createdAt',(asset.created_at AT TIME ZONE v_tz)::date)
      FROM public.assets asset LEFT JOIN public.rooms room ON room.id=asset.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=asset.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=asset.building_id AND building.organization_id=c.organization_id
      WHERE asset.organization_id=c.organization_id AND asset.deleted_at IS NULL
        AND (asset.building_id=ANY(buildings) OR (asset.building_id IS NULL AND org_wide AND asset.user_id=ANY(public.current_visible_owner_ids())))
        AND (query='' OR position(query IN lower(COALESCE(asset.name,'')||' '||COALESCE(asset.code,'')))>0)
      ORDER BY asset.created_at DESC,asset.id LIMIT 1));
  ELSIF p_domain='services' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT service.id,jsonb_build_object('id',service.id,'name',app_private.hermes_domain_text_v1(COALESCE(service.name,'')),
        'code',app_private.hermes_domain_text_v1(service.code),'unit',app_private.hermes_domain_text_v1(service.unit),'unitPrice',COALESCE(service.unit_price,0)::text,
        'buildingIds',COALESCE((SELECT jsonb_agg(DISTINCT bs.building_id ORDER BY bs.building_id) FROM public.building_services bs
          WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings)),'[]')) item
      FROM public.services service WHERE service.organization_id=c.organization_id AND service.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings))
          OR (org_wide AND service.user_id=ANY(public.current_visible_owner_ids()) AND NOT EXISTS(SELECT 1 FROM public.building_services bs
            WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active)))
        AND (cursor_id IS NULL OR service.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(service.name,'')||' '||COALESCE(service.code,'')))>0)
      ORDER BY service.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'byStatus','{}'::jsonb,'sum','{}'::jsonb) INTO v_summary
      FROM public.services service WHERE service.organization_id=c.organization_id AND service.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM public.building_services bs WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active AND bs.building_id=ANY(buildings))
          OR (org_wide AND service.user_id=ANY(public.current_visible_owner_ids()) AND NOT EXISTS(SELECT 1 FROM public.building_services bs
            WHERE bs.organization_id=c.organization_id AND bs.service_id=service.id AND bs.is_active)))
        AND (query='' OR position(query IN lower(COALESCE(service.name,'')||' '||COALESCE(service.code,'')))>0);
  ELSIF p_domain='tasks' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT job.id,jsonb_build_object('id',job.id,'title',app_private.hermes_domain_text_v1(COALESCE(job.title,'')),
        'code',app_private.hermes_domain_text_v1(job.code),'status',job.status,'buildingId',job.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'deadline',job.deadline) item
      FROM public.jobs job LEFT JOIN public.rooms room ON room.id=job.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=job.building_id AND room.building_id=ANY(buildings)
        LEFT JOIN public.buildings building ON building.id=job.building_id AND building.organization_id=c.organization_id
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (cursor_id IS NULL OR job.id>cursor_id) AND (v_status IS NULL OR job.status=v_status)
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0)
      ORDER BY job.id LIMIT row_limit+1) found;
    -- overdue: open tasks whose deadline has passed at statement time (now()).
    SELECT jsonb_build_object('count',COALESCE(sum(s.n),0)::bigint,'byStatus',COALESCE(jsonb_object_agg(s.status,s.n) FILTER (WHERE s.status IS NOT NULL),'{}'::jsonb),
        'sum','{}'::jsonb,'overdue',COALESCE(sum(s.overdue),0)::bigint) INTO v_summary FROM (
      SELECT job.status::text status,count(*) n,count(*) FILTER (WHERE job.status='IN_PROGRESS' AND job.deadline<now()) overdue FROM public.jobs job
      WHERE job.organization_id=c.organization_id AND (job.building_id=ANY(buildings) OR (job.building_id IS NULL AND org_wide))
        AND (v_status IS NULL OR job.status=v_status)
        AND (query='' OR position(query IN lower(COALESCE(job.title,'')||' '||COALESCE(job.code,'')))>0)
      GROUP BY 1) s;
  ELSE
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT building.id,jsonb_build_object('id',building.id,'buildingId',building.id,'name',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'total',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL),
        'occupied',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='OCCUPIED'),
        'available',(SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='AVAILABLE')) item
      FROM public.buildings building WHERE building.organization_id=c.organization_id AND building.deleted_at IS NULL AND building.id=ANY(buildings)
        AND (cursor_id IS NULL OR building.id>cursor_id) AND (query='' OR position(query IN lower(COALESCE(building.name,'')))>0)
      ORDER BY building.id LIMIT row_limit+1) found;
    SELECT jsonb_build_object('count',count(*),'total',COALESCE(sum(t.total),0)::bigint,'occupied',COALESCE(sum(t.occupied),0)::bigint,
        'available',COALESCE(sum(t.available),0)::bigint) INTO v_summary FROM (
      SELECT (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL) total,
        (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='OCCUPIED') occupied,
        (SELECT count(*) FROM public.rooms room WHERE room.organization_id=c.organization_id AND room.building_id=building.id AND room.deleted_at IS NULL AND room.status='AVAILABLE') available
      FROM public.buildings building WHERE building.organization_id=c.organization_id AND building.deleted_at IS NULL AND building.id=ANY(buildings)
        AND (query='' OR position(query IN lower(COALESCE(building.name,'')))>0)) t;
  END IF;
  IF jsonb_array_length(rows)>row_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
    next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
  END IF;
  IF octet_length(rows::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor,'summary',v_summary);
END $fn$;

-- No body binds the helper any more (the R2c part 2 reader above does not call it).
DROP FUNCTION IF EXISTS app_private.hermes_customers_without_contract_v1(uuid,uuid[],uuid[]);

ALTER FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb),public.hermes_domain_read_v1(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record;
BEGIN
  IF to_regprocedure('app_private.hermes_customers_without_contract_v1(uuid,uuid[],uuid[])') IS NOT NULL
    THEN RAISE EXCEPTION 'hermes_without_contract_revert_helper_left'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_rows_fast_v1(jsonb)');
  IF NOT FOUND OR p.prosecdef OR p.prosqlbody IS NULL OR position('withoutContract' IN pg_get_function_sqlbody(p.oid))>0
    OR position('status_v2' IN pg_get_function_sqlbody(p.oid))=0
    OR NOT has_function_privilege('authenticated','app_private.hermes_domain_read_rows_fast_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_domain_read_rows_fast_v1(jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_without_contract_revert_reader_unexpected'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR position('latestCount' IN p.prosrc)>0 OR position('v_summary:=v_summary||jsonb_build_object(''latest''' IN p.prosrc)=0
    OR NOT has_function_privilege('authenticated','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_domain_read_v1(jsonb,text,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_without_contract_revert_v1_unexpected'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
