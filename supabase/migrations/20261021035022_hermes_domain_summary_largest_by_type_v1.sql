-- R2c (21/10/2026): the largest voucher of each type. Production 21/10 after R2a: "Khoản chi lớn nhất tháng này là
-- gì?" ⇒ crm_read_income_expenses {fromDate,toDate} (the tool has no type parameter) ⇒ summary.largest was the largest
-- voucher of INCOME and EXPENSE together (an income voucher), so the bot could not name the largest expense.
-- public.hermes_domain_read_v2, income_expenses branch only: every summary.byType.<INCOME|EXPENSE> entry adds
-- `largest` — {id, code, name, type, totalAmount, voucherDate}, the shape of summary.largest — the largest voucher of
-- THAT type over the same filtered set (query/buildingId/status/fromDate/toDate, no cursor/LIMIT), CANCELLED vouchers
-- left out like every money figure of this summary, ties broken by id like summary.largest. summary.largest (both
-- types) stays for compatibility. byType keeps only the types present (an entry always has count >= 1, so its
-- largest is never null). Every other branch, the rows, order, cursor, limit+1, the other result keys, the
-- signature and the ACL are byte-identical to 20261020233934; the fast reader (rows_fast) has no income_expenses
-- branch. No new function.
-- RELEASE ORDER: the connector that accepts byType entries without `largest` (DOMAIN_SUMMARY_ENTRY_TOLERANT,
-- domain-contract.mjs) ships FIRST — the R2a connector checks byType entries exactly and would refuse this file's
-- output (backend_unavailable on crm_read_income_expenses). Prepared rollback (not a migration):
-- docs/plans/hermes-crm/revert/hermes_domain_summary_largest_by_type_revert_v1.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_domain_text_v1(text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'i' OR pg_get_userbyid(p.proowner)<>'postgres'
    THEN RAISE EXCEPTION 'hermes_domain_summary_largest_dependency_invalid: hermes_domain_text_v1'; END IF;
  -- R2a (20261020233934) must be live on v2: its summary (three WITH summaries, byType, largest) is what this file
  -- extends. The R2a body and this file's body both pass, so a second run is a no-op.
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR position('''summary'',v_summary' IN p.prosrc)=0 OR position('''byType''' IN p.prosrc)=0 OR position('''largest''' IN p.prosrc)=0
    OR (length(p.prosrc)-length(replace(p.prosrc,'v_summary:=(WITH','')))/length('v_summary:=(WITH')<>3
    THEN RAISE EXCEPTION 'hermes_domain_summary_largest_requires_applied_r2a_reads_v2'; END IF;
END $requires$;

-- The applied 20261020233934 body with one change: byType entries name their largest live voucher.
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

ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record; sig text:='public.hermes_domain_read_v2(jsonb,text,jsonb)';
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(sig);
  IF NOT FOUND OR pg_get_userbyid(p.proowner)<>'postgres' OR p.provolatile<>'v' OR NOT p.prosecdef
    OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
    OR has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
    OR has_function_privilege('hermes_store_executor',sig,'EXECUTE')
    THEN RAISE EXCEPTION 'hermes_domain_summary_largest_contract_violated: %',sig; END IF;
  -- Building names (B5c) and the R2a summary are kept; byType carries `largest` filtered by type over live vouchers.
  IF (length(p.prosrc)-length(replace(p.prosrc,'''buildingName''','')))/length('''buildingName''')<>4 OR position('buildingCode' IN p.prosrc)=0
    OR (length(p.prosrc)-length(replace(p.prosrc,'INTO v_summary','')))/length('INTO v_summary')<>2 OR (length(p.prosrc)-length(replace(p.prosrc,'v_summary:=(WITH','')))/length('v_summary:=(WITH')<>3
    OR position('''byBuilding''' IN p.prosrc)=0 OR position('''rooms''' IN p.prosrc)=0 OR position('''summary'',v_summary' IN p.prosrc)=0
    OR (length(p.prosrc)-length(replace(p.prosrc,'''largest''','')))/length('''largest''')<>2
    OR position('''sum'',t.amount::text,''largest'',(SELECT jsonb_build_object(' IN p.prosrc)=0
    OR position('FROM live big WHERE big.type=t.type ORDER BY big.total_amount DESC,big.id LIMIT 1' IN p.prosrc)=0
    THEN RAISE EXCEPTION 'hermes_domain_summary_largest_projection_missing'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
