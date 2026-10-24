-- Hermes Thu chi — lượt 15 (24/10/2026; nghiệm thu lượt cuối C3d trên TEST, connector 66df91e7, SOUL v4.23;
-- docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 26). Áp SAU 20261021185540 (đã áp production) — thân bộ đọc miền v2 của file đó
-- (md5 cf03a9fc…, production = TEST 24/10) là thân dựng từ.
-- Lỗi: crm_read_income_expenses {status:UNAPPROVED, limit:50} không lọc toà ⇒ backend_unavailable hai lần (TEST 18:42:44–18:43:12 UTC):
-- journal connector: finalizeMs 8457 / 8562 = trần statement_timeout 8 s của vai authenticated, handlerMs ~110 ⇒ câu SQL HẾT GIỜ, không
-- phải bước kiểm khuôn. Tái hiện tầng 2 (TEST, ROLLBACK, đúng kết nối và phiên): cùng lời gọi chỉ 154–899 ms (50 dòng / 162 phiếu), có lọc
-- toà 197 ms ⇒ câu không chậm; nó CHỜ. Bộ đọc lấy kết nối qua hàm lệnh dùng chung, hàm đó theo giao thức NGƯỜI GHI: khoá dòng công ty
-- FOR NO KEY UPDATE (lock_org_for_decision_v1) và FOR SHARE phiên / kết nối / token / trợ lý / chính sách. Mọi giao dịch ghi khác của cùng
-- công ty (web, Hermes ghi, cả một lượt đọc Hermes khác, phép đo ROLLBACK dài trên TEST) giữ khoá đó ⇒ lượt đọc xếp hàng tới hết 8 s ⇒ 57014
-- ⇒ backend_unavailable. Đọc không quyết định gì phải tuần tự hoá với người ghi: mỗi câu đã chạy trên snapshot mới (READ COMMITTED), như RLS
-- của web.
-- Sửa: (1) hàm đọc kết nối MỚI (app_private, …_read_connection_v1, mục 1 dưới) — chép đúng phần kiểm của hàm lệnh (thân 20261019034850, md5 0a2c941d…), bỏ khoá dòng
-- công ty và năm FOR SHARE; (2) bộ đọc miền v2 (income_expenses, receivables, meter_readings, deposits_held, building_profit) gọi bản đọc ở
-- cả hai chỗ (lấy kết nối đầu hàm, kiểm lại cuối hàm) — mọi dòng khác byte-identical với thân 20261021185540. Khuôn dòng / summary, chữ ký, ACL không đổi ⇒ connector KHÔNG phải
-- phát hành trước. Bộ đọc v1 / v3 / W2 chưa đổi (ngoài phạm vi Thu chi; báo cáo lượt 15).
-- $requires$ ghim md5 thân v2 đang chạy hoặc thân của file này, thân hàm lệnh (bản đọc chép từ nó) và thân bản đọc nếu đã có. Ghim chéo:
-- 20261021185540 ghim thân v2 ⇒ sau khi áp file này, chạy lại 185540 ngã đúng khối $requires$ (cần ngoại lệ pinned). Không ghi dữ liệu.
-- LÙI (không phải migration): áp lại thân v2 của 20261021185540 (bản đọc để lại vô hại).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR md5(replace(p.prosrc,chr(13),'')) NOT IN ('cf03a9fc85f7e4fb4b5b0b8636ee0ef9','af47eb16c1227abfb46c7f16ba6476f5')
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_requires_reviewed_v2: %',md5(replace(p.prosrc,chr(13),'')); END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_private_command_connection_v1(text)');
  IF NOT FOUND OR md5(replace(p.prosrc,chr(13),''))<>'0a2c941da4c710154bb6d1830b9cfa70'
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_requires_reviewed_command_connection: %',md5(replace(p.prosrc,chr(13),'')); END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_read_connection_v1(text)');
  IF FOUND AND md5(replace(p.prosrc,chr(13),''))<>'6a3f32dde3f150bd5d5ab0da4a3c203d'
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_read_connection_drift: %',md5(replace(p.prosrc,chr(13),'')); END IF;
END $requires$;

-- 1. Kết nối cho lượt ĐỌC (MỚI): phần kiểm của hàm lệnh 20261019034850, không khoá dòng nào.
CREATE OR REPLACE FUNCTION app_private.hermes_read_connection_v1(p_digest text)
RETURNS app_private.hermes_connections LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies; v_now timestamptz;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'hermes_command_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_digest;
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id;
  SELECT * INTO policy FROM app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id);
  v_now:=clock_timestamp();
  IF c.id IS NULL OR s.id IS NULL OR t.token_digest IS NULL OR a.id IS NULL OR policy.organization_id IS NULL
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR c.credential_ref IS DISTINCT FROM s.id
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=v_now
    OR s.user_id<>c.user_id OR s.organization_id<>c.organization_id OR s.assistant_id<>c.assistant_id
    OR t.connection_id<>c.id OR t.revoked_at IS NOT NULL OR t.expires_at<=v_now OR t.created_at>v_now OR t.created_at+interval '30 days'<=v_now
    OR a.state<>'ACTIVE' OR NOT policy.enabled OR (c.permission_mode<>'inherit_crm' AND (NOT(c.read_capabilities<@policy.read_capabilities)
    OR NOT(c.action_capabilities<@policy.action_capabilities) OR NOT(c.scope_ids<@policy.scope_ids)))
  THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;
  RETURN c;
END $$;

-- 2. Bộ đọc miền v2: thân 20261021185540 với một dòng đổi (lấy kết nối bằng bản đọc).
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
  -- Lượt 15 Thu chi (24/10): lấy kết nối KHÔNG khoá (đọc không xếp hàng sau người ghi của công ty); kiểm y như bản lệnh.
  c:=app_private.hermes_read_connection_v1(p_binding->>'tokenDigest');
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
    -- Nợ thực (20261021185540): nợ đã kéo sang hoá đơn gánh CÙNG tập lọc chỉ tính một lần, ở hoá đơn phát sinh gốc
    -- (public.invoice_effective_outstanding_v1, một lời gọi cho cả tập, không cursor); dòng có nợ thực 0 rơi khỏi
    -- danh sách, remainingAmount và mọi tổng là nợ thực. Đường nhanh dùng đúng công thức này.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      WITH owed AS MATERIALIZED (
        SELECT o.invoice_id,o.effective_outstanding FROM public.invoice_effective_outstanding_v1(ARRAY(
          SELECT invoice.id FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
          WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
            AND room.building_id=ANY(buildings) AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
            AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)
            AND (v_from IS NULL OR invoice.due_date>=v_from) AND (v_to IS NULL OR invoice.due_date<=v_to)
            AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0))) o)
      SELECT invoice.id,jsonb_build_object('id',invoice.id,'number',app_private.hermes_domain_text_v1(invoice.invoice_number),
        'status',invoice.status,'buildingId',room.building_id,'roomId',room.id,'roomName',app_private.hermes_domain_text_v1(room.name),
        'buildingName',app_private.hermes_domain_text_v1(COALESCE(building.name,'')),'buildingCode',app_private.hermes_domain_text_v1(building.code),
        'billingMonth',app_private.hermes_domain_text_v1(invoice.billing_month),'dueDate',invoice.due_date,
        'totalAmount',COALESCE(invoice.total_amount,0)::text,'paidAmount',COALESCE(invoice.paid_amount,0)::text,
        'remainingAmount',owed.effective_outstanding::text) item
      FROM public.invoices invoice JOIN owed ON owed.invoice_id=invoice.id AND owed.effective_outstanding>0
      JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
      LEFT JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
        AND room.building_id=ANY(buildings) AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
        AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)
        AND (cursor_id IS NULL OR invoice.id>cursor_id)
        AND (v_from IS NULL OR invoice.due_date>=v_from) AND (v_to IS NULL OR invoice.due_date<=v_to)
        AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0)
      ORDER BY invoice.id LIMIT row_limit+1) found;
    -- Same summary as the fast reader (text through hermes_domain_text_v1 here, hermes_read_text_v1 there).
    v_summary:=(WITH owed AS MATERIALIZED (
        SELECT o.invoice_id,o.effective_outstanding FROM public.invoice_effective_outstanding_v1(ARRAY(
          SELECT invoice.id FROM public.invoices invoice JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
          WHERE invoice.organization_id=c.organization_id AND invoice.deleted_at IS NULL AND invoice.building_id=room.building_id
            AND room.building_id=ANY(buildings) AND invoice.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE')
            AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)
            AND (v_from IS NULL OR invoice.due_date>=v_from) AND (v_to IS NULL OR invoice.due_date<=v_to)
            AND (query='' OR position(query IN lower(COALESCE(invoice.invoice_number,'')||' '||COALESCE(room.name,'')))>0))) o),
      debt AS (
        SELECT invoice.status::text status,room.building_id,building.name building_name,invoice.total_amount,invoice.paid_amount,owed.effective_outstanding remaining_amount
        FROM public.invoices invoice JOIN owed ON owed.invoice_id=invoice.id AND owed.effective_outstanding>0
        JOIN public.rooms room ON room.id=invoice.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL
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
  -- Kiểm lại sau khi đọc: cùng bản đọc (không khoá).
  PERFORM app_private.hermes_read_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,'items',rows,'nextCursor',next_cursor,'summary',v_summary,
    'source',v_source,'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $fn$;

ALTER FUNCTION app_private.hermes_read_connection_v1(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_read_connection_v1(text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_read_v2(jsonb,text,jsonb) TO authenticated;

DO $assert$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_read_connection_v1(text)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR md5(replace(p.prosrc,chr(13),''))<>'6a3f32dde3f150bd5d5ab0da4a3c203d'
    OR p.prosrc ~* '(FOR (NO KEY )?UPDATE|FOR (KEY )?SHARE|lock_org_for_decision|advisory)'
    OR replace(COALESCE(array_to_string(p.proconfig,','),''),'"','')<>'search_path=pg_catalog, public, app_private'
    OR has_function_privilege('authenticated','app_private.hermes_read_connection_v1(text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_read_connection_v1(text)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_read_connection_v1(text)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','app_private.hermes_read_connection_v1(text)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_read_connection_contract_violated'; END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'v' OR pg_get_userbyid(p.proowner)<>'postgres'
    OR md5(replace(p.prosrc,chr(13),''))<>'af47eb16c1227abfb46c7f16ba6476f5'
    OR position('app_private.hermes_read_connection_v1(p_binding->>''tokenDigest'')' IN p.prosrc)=0
    OR position('hermes_private_command_connection_v1' IN p.prosrc)>0
    OR NOT has_function_privilege('authenticated','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_v2_contract_violated'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('hermes_domain_read_v2','hermes_read_connection_v1'))<>2
    THEN RAISE EXCEPTION 'hermes_domain_read_nolock_overload_created'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
