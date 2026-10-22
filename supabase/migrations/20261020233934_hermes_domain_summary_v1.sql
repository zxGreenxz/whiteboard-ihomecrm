-- R2a (21/10/2026): every list tool answers "how many / how much" from the server. The 79-question
-- production run (69 %) showed the model counting or adding rows by hand and stopping after a few
-- pages (T9/T5). Each list read now carries `summary`, computed in the same call over the WHOLE
-- filtered set (query/buildingId/status/fromDate/toDate), without cursor or limit, under the same
-- company/building scope (and, on the fast lane, the same RLS) as `items`:
-- - hermes_domain_read_v1 (leads, contracts, invoices, assets, services, tasks; the legacy customers
--   and occupancy branches summarise too): {count, byStatus, sum}. byStatus counts the status column
--   (assets: `condition`), only values present; sum: assets {quantity}, others {} (invoices {} like
--   the fast lane: a total over every invoice status would mislead; invoice_report stats has it);
--   tasks add `overdue` (IN_PROGRESS with deadline < now(), as the web isOverdue).
-- - hermes_domain_read_v2: income_expenses add byType/largest (money without CANCELLED vouchers,
--   count/byStatus with them), receivables add byBuilding (<= 50, remainingAmount desc),
--   meter_readings add byType/rooms, deposits_held and building_profit return totals.
-- - the shared INVOKER reader (rows_fast): receivables repeats the v2 summary under the asker's
--   RLS; customers/invoices take the totals the shared cores compute before paging (`total` /
--   `total_count`); contracts take the core total and group byStatus under RLS only when query=''
--   (the core matches ILIKE on several columns and is not copied), null otherwise.
-- Rows, order, cursor, limit+1, the other result keys, signatures and ACL are unchanged; no new
-- function. The connector accepts an absent `summary` for one release (summaryTolerant), so it
-- ships first. hermes_domain_read_v3 (customers, occupancy) is a wave-2 foundation function: it
-- follows, with app_private.hermes_report_read_v2 (monthly_pnl totals), in
-- 20261021004841_hermes_w2_domain_summary_v1.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_text_v1(text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_domain_summary_dependency_invalid: hermes_domain_text_v1'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_read_text_v1(text)');
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_domain_summary_dependency_invalid: hermes_read_text_v1'; END IF;
  -- B5c step 2 (20261020173818) must be live on all three lanes this file replaces. `>=` keeps the
  -- block true on a second run, when the bodies below (one more 'buildingName' in v2) are live.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR (length(p.prosrc)-length(replace(p.prosrc,'''buildingName''','')))/length('''buildingName''')<5
    THEN RAISE EXCEPTION 'hermes_domain_summary_requires_applied_b5c_step2_reads_v1'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR (length(p.prosrc)-length(replace(p.prosrc,'''buildingName''','')))/length('''buildingName''')<3 OR position('buildingCode' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_requires_applied_b5c_step2_reads_v2'; END IF;
  SELECT q.oid,q.prosecdef,q.provolatile,q.proowner,q.prosqlbody INTO p FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='app_private' AND q.proname='hermes_domain_read_rows_fast_v1';
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosqlbody IS NULL
    OR position('current_building_name' IN pg_get_function_sqlbody(p.oid))=0 OR position('buildingCode' IN pg_get_function_sqlbody(p.oid))=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_requires_applied_b5c_step2_reader'; END IF;
END $requires$;

-- Parsed SQL body binds helper OIDs at creation. Business rows remain INVOKER:
-- never execute this reader from a SECURITY DEFINER broker/adapter. The receivables
-- summary repeats the row filter without cursor/limit under the same RLS; the
-- customers/invoices/contracts counts are the totals the shared cores already compute
-- before paging, and the contracts byStatus is grouped under RLS only without a query.
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
    WHEN 'customers' THEN jsonb_build_object('count',data->'total','byStatus','{}'::jsonb,'sum','{}'::jsonb)
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

-- Family v1 reserve lane (also the only lane of leads, assets, services, tasks): the applied
-- 20261020173818 body plus one summary statement per branch (same WHERE, no cursor, no LIMIT).
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; capabilities jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; org_wide boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; rows jsonb; next_cursor uuid; v_summary jsonb;
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
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT asset.id,jsonb_build_object('id',asset.id,'name',app_private.hermes_domain_text_v1(COALESCE(asset.name,'')),
        'code',app_private.hermes_domain_text_v1(asset.code),'condition',asset.condition,'buildingId',asset.building_id,'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),
        'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),'quantity',COALESCE(asset.quantity,0)::text) item
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

-- Family v2 reserve lane (live lane of income_expenses, meter_readings, deposits_held,
-- building_profit; receivables when the host does not opt into the fast path): the applied
-- 20261020173818 body plus one summary per branch.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v2(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; v_source text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; v_from date; v_to date; rows jsonb; next_cursor uuid; v_summary jsonb;
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

  -- Each branch: the page (cursor, LIMIT row_limit+1) and then the summary of the whole
  -- filtered set (same WHERE without cursor_id, no LIMIT).
  IF p_domain='income_expenses' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT ie.id,jsonb_build_object('id',ie.id,'code',app_private.hermes_domain_text_v1(ie.code),'type',ie.type,
        'name',app_private.hermes_domain_text_v1(COALESCE(ie.name,'')),'buildingId',ie.building_id,
        'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),'roomId',room.id,
        'roomName',app_private.hermes_domain_text_v1(room.name),'voucherDate',ie.voucher_date,
        'totalAmount',COALESCE(ie.total_amount,0)::text,'approvalStatus',ie.approval_status) item
      FROM public.income_expenses ie LEFT JOIN public.rooms room ON room.id=ie.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=ie.building_id
      LEFT JOIN public.buildings building ON building.id=ie.building_id AND building.organization_id=c.organization_id
      WHERE ie.organization_id=c.organization_id AND ie.deleted_at IS NULL AND ie.building_id=ANY(buildings)
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
          AND ie.type IN ('INCOME','EXPENSE') AND NOT COALESCE(ie.has_restricted_item,true)
          AND ie.salary_staff_id IS NULL AND ie.shareholder_id IS NULL AND ie.profit_manager_id IS NULL
          AND (v_status IS NULL OR ie.approval_status=v_status)
          AND (v_from IS NULL OR ie.voucher_date>=v_from) AND (v_to IS NULL OR ie.voucher_date<=v_to)
          AND (query='' OR position(query IN lower(COALESCE(ie.name,'')||' '||COALESCE(ie.code,'')))>0)
      ), live AS (SELECT * FROM f WHERE f.approval_status IS DISTINCT FROM 'CANCELLED')
      SELECT jsonb_build_object('count',(SELECT count(*) FROM f),
        'byStatus',COALESCE((SELECT jsonb_object_agg(s.approval_status,s.n) FROM (SELECT f.approval_status,count(*) n FROM f WHERE f.approval_status IS NOT NULL GROUP BY 1) s),'{}'::jsonb),
        'sum',jsonb_build_object('totalAmount',COALESCE((SELECT sum(live.total_amount) FROM live),0)::text),
        'byType',COALESCE((SELECT jsonb_object_agg(t.type,jsonb_build_object('count',t.n,'sum',t.amount::text))
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

ALTER FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v1(jsonb,text,jsonb),public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb),public.hermes_domain_read_v1(jsonb,text,jsonb),public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text; body text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)',
    'app_private.hermes_domain_read_rows_fast_v1(jsonb)','public.hermes_domain_read_fast_v1(jsonb,text,jsonb)',
    'public.hermes_domain_read_v1(jsonb,text,jsonb)','public.hermes_domain_read_v2(jsonb,text,jsonb)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR pg_get_userbyid(p.proowner)<>'postgres'
      OR p.provolatile<>(CASE WHEN sig LIKE 'public.hermes_domain_read_v_(%' THEN 'v' ELSE 's' END)
      OR p.prosecdef IS DISTINCT FROM (sig LIKE 'app_private.hermes_domain_read_scope_fast_v1%' OR sig LIKE 'public.hermes_domain_read_v_(%')
      OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
      OR has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_domain_summary_contract_violated: %',sig; END IF;
  END LOOP;
  -- The invoker reader keeps its parsed body and empty search_path (stored as
  -- search_path=""): helper OIDs are bound at creation and no name is ever
  -- resolved as the asker. Every lane projects the building name and a summary.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_rows_fast_v1(jsonb)');
  IF p.prosqlbody IS NULL OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path='
    THEN RAISE EXCEPTION 'hermes_domain_summary_reader_path_changed'; END IF;
  body:=pg_get_function_sqlbody(p.oid);
  IF position('current_building_name' IN body)=0 OR position('buildingCode' IN body)=0
    OR position('''summary''' IN body)=0 OR position('''byBuilding''' IN body)=0 OR position('total_count' IN body)=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_reader_projection_missing'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v1(jsonb,text,jsonb)');
  IF (length(p.prosrc)-length(replace(p.prosrc,'''buildingName''','')))/length('''buildingName''')<>5
    OR (length(p.prosrc)-length(replace(p.prosrc,'INTO v_summary','')))/length('INTO v_summary')<>8
    OR position('''overdue''' IN p.prosrc)=0 OR position('''summary'',v_summary' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_v1_projection_missing'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF (length(p.prosrc)-length(replace(p.prosrc,'''buildingName''','')))/length('''buildingName''')<>4 OR position('buildingCode' IN p.prosrc)=0
    OR (length(p.prosrc)-length(replace(p.prosrc,'INTO v_summary','')))/length('INTO v_summary')<>2
    OR (length(p.prosrc)-length(replace(p.prosrc,'v_summary:=(WITH','')))/length('v_summary:=(WITH')<>3
    OR position('''byBuilding''' IN p.prosrc)=0 OR position('''largest''' IN p.prosrc)=0 OR position('''rooms''' IN p.prosrc)=0
    OR position('''summary'',v_summary' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_v2_projection_missing'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
