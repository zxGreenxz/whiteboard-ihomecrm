-- B5c (21/10/2026): crm_read_receivables names the building. On production the
-- model only received buildingId (UUID), roomId and roomName, so "còn phòng nào
-- chưa đóng tiền" could not be grouped by building (room "201" repeats across
-- buildings). Both lanes of the receivables domain gain buildingName (text,
-- empty when unknown) and buildingCode (text or null) read from public.buildings
-- by the room's building_id: the shared INVOKER reader under the asker's RLS and
-- the SECURITY DEFINER hermes_domain_read_v2 reserve lane, so normal-vs-fast
-- parity holds and readFastPath can be switched off without losing the columns.
-- A soft-deleted building still names an invoice that is listed (LEFT JOIN
-- without deleted_at; the admission already drops deleted buildings from the
-- scope). Every other column, order, cursor and limit+1 stays as B2
-- (20261020101836). No signature changes, no new function; B2 must be applied.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_text_v1(text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_receivables_building_dependency_invalid: hermes_domain_text_v1'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_read_text_v1(text)');
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_receivables_building_dependency_invalid: hermes_read_text_v1'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_receivables_building_requires_applied_reads_v2'; END IF;
  -- B2 (20261020101836) must already be live: the admission maps receivables to
  -- invoices.view and the shared reader is the parsed INVOKER body it replaced.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR position('WHEN ''receivables'' THEN ''invoices.view''' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_receivables_building_requires_applied_b2_admission'; END IF;
  SELECT q.prosecdef,q.provolatile,q.proowner,q.prosqlbody INTO p FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='app_private' AND q.proname='hermes_domain_read_rows_fast_v1';
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosqlbody IS NULL
    THEN RAISE EXCEPTION 'hermes_receivables_building_requires_shared_invoker_reader'; END IF;
END $requires$;

-- Parsed SQL body binds helper OIDs at creation. Business rows remain INVOKER:
-- never execute this reader from a SECURITY DEFINER broker/adapter. The
-- receivables branch keeps the Hermes-owned v2 meaning and now carries the
-- building name/code of the room, read through the asker's RLS on buildings.
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
    'roomId',e->'hermes_room_id','roomName',public.hermes_read_text_v1(e->>'current_room_name'))
   WHEN 'contracts' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'contract_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e#>'{room,building_id}','roomId',e->'room_id','startDate',e->'start_date','endDate',e->'end_date')
   WHEN 'invoices' THEN jsonb_build_object('id',e->'id','number',public.hermes_read_text_v1(e->>'invoice_number'),
    'status',public.hermes_read_text_v1(e->>'status'),'buildingId',e->'building_id','roomId',e->'room_id',
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
    THEN (SELECT to_jsonb(id) FROM projected ORDER BY id OFFSET (p_plan->>'limit')::integer-1 LIMIT 1) ELSE 'null'::jsonb END)
   || CASE p->>'domain' WHEN 'customers' THEN jsonb_build_object('fetchedAt',p->'fetchedAt')
    WHEN 'receivables' THEN jsonb_build_object('source','crm.invoices','fetchedAt',p->'fetchedAt') ELSE '{}'::jsonb END value FROM plan
 ) SELECT value FROM result;
END;

-- Reserve lane (readFastPath off): the applied 20261015120000 body with the same
-- two columns on the receivables row. Every other domain branch is unchanged.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v2(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; v_source text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_status text; v_from date; v_to date; rows jsonb; next_cursor uuid;
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

  IF p_domain='income_expenses' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT ie.id,jsonb_build_object('id',ie.id,'code',app_private.hermes_domain_text_v1(ie.code),'type',ie.type,
        'name',app_private.hermes_domain_text_v1(COALESCE(ie.name,'')),'buildingId',ie.building_id,'roomId',room.id,
        'roomName',app_private.hermes_domain_text_v1(room.name),'voucherDate',ie.voucher_date,
        'totalAmount',COALESCE(ie.total_amount,0)::text,'approvalStatus',ie.approval_status) item
      FROM public.income_expenses ie LEFT JOIN public.rooms room ON room.id=ie.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=ie.building_id
      WHERE ie.organization_id=c.organization_id AND ie.deleted_at IS NULL AND ie.building_id=ANY(buildings)
        AND ie.type IN ('INCOME','EXPENSE') AND NOT COALESCE(ie.has_restricted_item,true)
        AND ie.salary_staff_id IS NULL AND ie.shareholder_id IS NULL AND ie.profit_manager_id IS NULL
        AND (cursor_id IS NULL OR ie.id>cursor_id) AND (v_status IS NULL OR ie.approval_status=v_status)
        AND (v_from IS NULL OR ie.voucher_date>=v_from) AND (v_to IS NULL OR ie.voucher_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(ie.name,'')||' '||COALESCE(ie.code,'')))>0)
      ORDER BY ie.id LIMIT row_limit+1) found;
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
  ELSIF p_domain='meter_readings' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT reading.id,jsonb_build_object('id',reading.id,'code',app_private.hermes_domain_text_v1(reading.reading_code),
        'buildingId',reading.building_id,'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),
        'meterType',reading.meter_type,'settlementMonth',app_private.hermes_domain_text_v1(reading.settlement_month),
        'readingDate',reading.reading_date,'previousReading',COALESCE(reading.previous_reading,0)::text,
        'currentReading',reading.current_reading::text,'consumption',reading.consumption::text,'status',reading.status) item
      FROM public.meter_readings reading LEFT JOIN public.rooms room ON room.id=reading.room_id AND room.organization_id=c.organization_id
        AND room.deleted_at IS NULL AND room.building_id=reading.building_id
      WHERE reading.organization_id=c.organization_id AND reading.deleted_at IS NULL AND reading.building_id=ANY(buildings)
        AND (cursor_id IS NULL OR reading.id>cursor_id) AND (v_status IS NULL OR reading.status=v_status)
        AND (v_from IS NULL OR reading.reading_date>=v_from) AND (v_to IS NULL OR reading.reading_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(reading.reading_code,'')||' '||COALESCE(room.name,'')))>0)
      ORDER BY reading.id LIMIT row_limit+1) found;
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
  END IF;
  IF jsonb_array_length(rows)>row_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
    next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
  END IF;
  IF octet_length(rows::text)>60000 THEN RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor,
    'source',v_source,'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $fn$;

ALTER FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_domain_read_rows_fast_v1(jsonb),public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)',
    'app_private.hermes_domain_read_rows_fast_v1(jsonb)','public.hermes_domain_read_fast_v1(jsonb,text,jsonb)',
    'public.hermes_domain_read_v2(jsonb,text,jsonb)'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT FOUND OR pg_get_userbyid(p.proowner)<>'postgres'
      OR p.provolatile<>(CASE WHEN sig LIKE 'public.hermes_domain_read_v2%' THEN 'v' ELSE 's' END)
      OR p.prosecdef IS DISTINCT FROM (sig LIKE 'app_private.hermes_domain_read_scope_fast_v1%' OR sig LIKE 'public.hermes_domain_read_v2%')
      OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
      OR has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
      OR has_function_privilege('hermes_store_executor',sig,'EXECUTE')
      THEN RAISE EXCEPTION 'hermes_receivables_building_contract_violated: %',sig; END IF;
  END LOOP;
  -- The invoker reader keeps its parsed body and empty search_path (stored as
  -- search_path=""): helper OIDs are bound at creation and no name is ever
  -- resolved as the asker. Both lanes now project the building on the row.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_read_rows_fast_v1(jsonb)');
  IF p.prosqlbody IS NULL OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path='
    THEN RAISE EXCEPTION 'hermes_receivables_building_reader_path_changed'; END IF;
  IF position('buildingName' IN pg_get_function_sqlbody(p.oid))=0 OR position('buildingCode' IN pg_get_function_sqlbody(p.oid))=0
    THEN RAISE EXCEPTION 'hermes_receivables_building_reader_projection_missing'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF position('buildingName' IN p.prosrc)=0 OR position('buildingCode' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_receivables_building_reserve_projection_missing'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
