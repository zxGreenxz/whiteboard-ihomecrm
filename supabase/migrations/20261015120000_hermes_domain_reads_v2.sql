-- Hermes đọc CRM, họ miền v2: thu chi, công nợ, chỉ số công tơ, cọc đang giữ và
-- lãi lỗ theo toà. Cùng khuôn hermes_domain_read_v1: quyền CRM hiện tại
-- (get_authorization_context_v1 + authorized_scope_v3 của đúng khoá quyền) giao
-- với overlay Read/scope đã lưu của kết nối Hermes; SQL là lớp quyết định cuối.
-- Projection cố định: không số tài khoản, người nộp/nhận, ghi chú, ảnh, toạ độ,
-- CCCD. Phiếu có hạng mục hạn chế hoặc phiếu lương/cổ đông/quản lý lợi nhuận
-- không trả. Báo cáo gọi đúng hàm canonical (get_held_deposit_summary,
-- fa_monthly_pnl) với tập toà đã giao, không để mô hình tự tính. Năng lực mới
-- đăng ký TẮT; migration không ghi dữ liệu nghiệp vụ, không cấp quyền user.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  ('income_expenses.view','read',false),('meter_readings.view','read',false),
  ('deposits.view','read',false),('reports_finance.analysis','read',false)
ON CONFLICT(capability) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.hermes_domain_date_v2(p jsonb)
RETURNS date LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v date;
BEGIN
  IF p IS NULL OR p='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p)<>'string' OR (p#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  BEGIN v:=(p#>>'{}')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END;
  IF to_char(v,'YYYY-MM-DD')<>(p#>>'{}') OR v<DATE '2000-01-01' OR v>DATE '2100-12-31'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  RETURN v;
END $fn$;

-- One CRM permission key: company/registry ceiling supplied by the caller,
-- current CRM grant from the authorization context and its permission-specific
-- building scope. It conveys no Hermes overlay and is never exposed to the API.
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

CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v2(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text; state jsonb; result jsonb:='{}'; enabled boolean;
  keys constant text[]:=ARRAY['income_expenses.view','meter_readings.view','deposits.view','reports_finance.analysis'];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
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
    state:=app_private.hermes_domain_grant_v2(p_organization_id,key,enabled,context);
    result:=result||jsonb_build_object(key,state-'orgWide');
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

-- The connection lock excludes revoke/rebind while each read runs; the final
-- response repeats the lifetime checks, so a slow query cannot outlive it.
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
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),
        'billingMonth',app_private.hermes_domain_text_v1(invoice.billing_month),'dueDate',invoice.due_date,
        'totalAmount',COALESCE(invoice.total_amount,0)::text,'paidAmount',COALESCE(invoice.paid_amount,0)::text,
        'remainingAmount',invoice.remaining_amount::text) item
      FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
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

ALTER FUNCTION app_private.hermes_domain_date_v2(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_date_v2(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_domain_capabilities_v2(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v2(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v2(uuid) TO authenticated;
ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
