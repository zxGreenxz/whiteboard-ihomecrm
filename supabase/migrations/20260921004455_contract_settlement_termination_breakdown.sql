-- Exact termination settlement breakdown for the shared contract settlement reader.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolinherit)
     OR NOT pg_has_role('ie_action_snapshot_reader','authenticated','USAGE')
     OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE')
     OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN
    RAISE EXCEPTION 'Financial reader role drift';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='ie_action_snapshot_reader'::regrole AND member<>'postgres'::regrole)
     OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='ie_action_snapshot_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option)) THEN
    RAISE EXCEPTION 'Financial reader membership drift';
  END IF;
  IF to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)') IS NULL
     OR md5(pg_get_functiondef(to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)'))) NOT IN ('d90aa180120852f3f38a7a0b32c5ad2f','37f886b6cf56450fa40c0e544999e2c4')
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)')) <> 'ie_action_snapshot_reader' THEN
    RAISE EXCEPTION 'Financial reader prerequisite drift';
  END IF;
  IF to_regprocedure('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)') IS NOT NULL
     AND (md5(pg_get_functiondef(to_regprocedure('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)'))) <> 'a7e62c0b18de2e41dad077dc71e0c3cf'
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)')) <> 'ie_action_snapshot_reader') THEN
    RAISE EXCEPTION 'Termination breakdown definition/owner drift';
  END IF;
  IF to_regprocedure('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)') IS NOT NULL
     AND (md5(pg_get_functiondef(to_regprocedure('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)'))) <> 'c5305a2c11de314dc4eb4b04d8cdfdaa'
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)')) <> 'postgres') THEN
    RAISE EXCEPTION 'Termination voucher link definition/owner drift';
  END IF;
  IF NOT has_function_privilege('authenticated','public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')
     OR (to_regprocedure('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)') IS NOT NULL AND (
       NOT has_function_privilege('ie_action_snapshot_reader','app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','EXECUTE')
       OR has_function_privilege('authenticated','app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','EXECUTE')
       OR has_function_privilege('anon','app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','EXECUTE')
       OR has_function_privilege('service_role','app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','EXECUTE')))
     OR (to_regprocedure('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)') IS NOT NULL AND (
       NOT has_function_privilege('ie_action_snapshot_reader','app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','EXECUTE')
       OR has_function_privilege('authenticated','app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','EXECUTE')
       OR has_function_privilege('anon','app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','EXECUTE')
       OR has_function_privilege('service_role','app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','EXECUTE'))) THEN
    RAISE EXCEPTION 'Termination breakdown ACL drift';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION app_private.settlement_termination_voucher_link_v1(p_org uuid,p_contract uuid,p_termination uuid,p_voucher uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
BEGIN
  PERFORM app_private.income_expense_action_scope_v1(p_org);
  RETURN EXISTS(SELECT 1 FROM public.termination_refund_obligations o
    WHERE o.organization_id=p_org AND o.contract_id=p_contract
      AND o.termination_id=p_termination AND o.voucher_id=p_voucher);
END
$fn$;
ALTER FUNCTION app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid) TO ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION app_private.settlement_termination_breakdown_v1(
  p_org uuid,
  p_contract uuid,
  p_termination uuid,
  p_voucher uuid,
  p_invoices_complete boolean,
  p_voucher_items_complete boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
SET row_security=on
AS $fn$
DECLARE
  t public.contract_terminations;
  v public.income_expenses;
  settlement_invoice_id uuid;
  settlement_items jsonb := '[]'::jsonb;
  refund_items jsonb := '[]'::jsonb;
  settlement_item_total numeric := 0;
  refund_item_total numeric := 0;
  refund_excess_item_total numeric := 0;
  refund_item_count integer := 0;
  typed_refund_item_count integer := 0;
  excess_rent numeric := 0;
  reason text;
BEGIN
  PERFORM app_private.income_expense_action_scope_v1(p_org);
  IF p_contract IS NULL OR p_termination IS NULL THEN RETURN NULL; END IF;

  SELECT x.* INTO t
  FROM public.contract_terminations x
  JOIN public.contracts c ON c.id=x.contract_id AND c.organization_id=p_org AND c.deleted_at IS NULL
  JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=p_org AND r.deleted_at IS NULL
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_org AND b.deleted_at IS NULL
  WHERE x.id=p_termination AND x.contract_id=p_contract AND x.organization_id=p_org
    AND (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id));
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_voucher IS NOT NULL THEN
    SELECT x.* INTO v FROM public.income_expenses x
    WHERE x.id=p_voucher AND x.organization_id=p_org AND x.deleted_at IS NULL
      AND x.system_source='termination.refund';
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF NOT app_private.settlement_termination_voucher_link_v1(p_org,p_contract,p_termination,p_voucher) THEN RETURN NULL; END IF;
  END IF;

  IF NOT COALESCE(p_invoices_complete,false) THEN
    RETURN jsonb_build_object('complete',false,'terminationId',t.id,'contractId',t.contract_id,'reason','INVOICES_INCOMPLETE');
  END IF;
  IF p_voucher IS NULL THEN
    RETURN jsonb_build_object('complete',false,'terminationId',t.id,'contractId',t.contract_id,'reason','REFUND_VOUCHER_REQUIRED_FOR_EXCESS');
  END IF;
  IF NOT COALESCE(p_voucher_items_complete,false) THEN
    RETURN jsonb_build_object('complete',false,'terminationId',t.id,'contractId',t.contract_id,'reason','REFUND_ITEMS_INCOMPLETE');
  END IF;

  SELECT i.id INTO settlement_invoice_id FROM public.invoices i
  WHERE i.organization_id=p_org AND i.contract_id=p_contract
    AND i.kind='SETTLEMENT' AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
  ORDER BY i.created_at DESC,i.id DESC LIMIT 1;

  IF settlement_invoice_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description',COALESCE(NULLIF(ii.description,''),'Khoản thu thêm'),
      'amount',COALESCE(ii.amount,0),
      'type',ii.type::text
    ) ORDER BY ii.sort_order,ii.id),'[]'::jsonb)
    INTO settlement_items FROM public.invoice_items ii WHERE ii.invoice_id=settlement_invoice_id;
    SELECT COALESCE(sum(COALESCE(ii.amount,0)),0) INTO settlement_item_total
    FROM public.invoice_items ii WHERE ii.invoice_id=settlement_invoice_id;
  END IF;

  IF p_voucher IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description',COALESCE(it.description,''),
      'amount',COALESCE(it.amount,it.unit_price*it.quantity,0),
      'typeName',ty.name,
      'isDeposit',COALESCE(ty.is_deposit,false)
    ) ORDER BY it.created_at,it.id),'[]'::jsonb)
    INTO refund_items
    FROM public.income_expense_items it
    JOIN public.income_expense_types ty ON ty.id=it.income_expense_type_id
    WHERE it.income_expense_id=p_voucher AND it.organization_id=p_org;
    SELECT count(*),COALESCE(sum(COALESCE(it.amount,it.unit_price*it.quantity,0)),0)
    INTO refund_item_count,refund_item_total
    FROM public.income_expense_items it WHERE it.income_expense_id=p_voucher AND it.organization_id=p_org;
    SELECT count(*),COALESCE(sum(CASE WHEN ty.name='Hoàn tiền thừa thanh lý' THEN COALESCE(it.amount,it.unit_price*it.quantity,0) ELSE 0 END),0)
    INTO typed_refund_item_count,refund_excess_item_total
    FROM public.income_expense_items it JOIN public.income_expense_types ty ON ty.id=it.income_expense_type_id
    WHERE it.income_expense_id=p_voucher AND it.organization_id=p_org;
  END IF;

  excess_rent := CASE
    WHEN t.total_deductions<=t.total_deposit THEN refund_excess_item_total
    WHEN refund_excess_item_total>0 THEN t.total_deductions-t.total_deposit+refund_excess_item_total
    ELSE NULL END;

  reason := CASE
    WHEN t.outstanding_debt IS NULL OR t.early_termination_fee IS NULL
      OR t.total_deductions IS NULL OR t.refund_amount IS NULL THEN 'TERMINATION_INPUTS_UNAVAILABLE'
    WHEN COALESCE(t.early_termination_fee,0)>0 AND settlement_invoice_id IS NULL THEN 'SETTLEMENT_ITEMS_UNAVAILABLE'
    WHEN abs(settlement_item_total-t.early_termination_fee)>1 THEN 'SETTLEMENT_ITEMS_MISMATCH'
    WHEN refund_item_count<>typed_refund_item_count THEN 'REFUND_TYPES_UNAVAILABLE'
    WHEN abs(refund_item_total-v.total_amount)>1 THEN 'REFUND_ITEMS_MISMATCH'
    WHEN excess_rent IS NULL THEN 'EXCESS_RENT_UNAVAILABLE'
    WHEN abs(v.total_amount-GREATEST(t.total_deposit+excess_rent+t.rent_refund_amount-t.total_deductions,0))>1 THEN 'REFUND_TOTAL_INCONSISTENT'
    ELSE NULL END;

  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('complete',false,'terminationId',t.id,'contractId',t.contract_id,'reason',reason);
  END IF;
  RETURN jsonb_build_object(
    'complete',true,'terminationId',t.id,'contractId',t.contract_id,
    'actualMoveOutDate',t.actual_move_out_date,'depositUsed',COALESCE(t.total_deposit,0),
    'outstandingDebt',COALESCE(t.outstanding_debt,0),
    'earlyTerminationFee',COALESCE(t.early_termination_fee,0),
    'rentRefundAmount',COALESCE(t.rent_refund_amount,0),
    'totalDeductions',t.total_deductions,'refundAmount',t.refund_amount,
    'excessRent',excess_rent,'shortfallMode',NULL,
    'settlementItems',settlement_items,'refundItems',refund_items);
END
$fn$;

GRANT CREATE ON SCHEMA app_private TO ie_action_snapshot_reader;
ALTER FUNCTION app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA app_private FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.read_contract_settlement_financial_facts_v1(p_organization_id uuid,p_room_id uuid DEFAULT NULL,p_contract_id uuid DEFAULT NULL,p_termination_id uuid DEFAULT NULL,p_voucher_id uuid DEFAULT NULL,p_source_receipt_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET row_security=on AS $fn$
DECLARE c public.contracts; v public.income_expenses; t public.contract_terminations; ob public.termination_refund_obligations;
 ids uuid[]; visible_ids uuid[]; evidence jsonb; result jsonb; breakdown jsonb;
 invoices_complete boolean:=false; voucher_items_complete boolean:=false;
 term_id uuid:=p_termination_id; v_contract_id uuid:=p_contract_id; v_room_id uuid:=p_room_id;
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_organization_id);
 IF p_voucher_id IS NOT NULL THEN
 SELECT * INTO v FROM public.income_expenses x WHERE x.id=p_voucher_id AND x.organization_id=p_organization_id AND x.deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Financial scope unavailable' USING ERRCODE='42501'; END IF;
 IF v_contract_id IS NOT NULL AND v.contract_id IS DISTINCT FROM v_contract_id THEN RAISE EXCEPTION 'Voucher contract mismatch' USING ERRCODE='42501'; END IF;
 v_contract_id:=COALESCE(v_contract_id,v.contract_id); v_room_id:=COALESCE(v_room_id,v.room_id);
 IF term_id IS NULL AND v.system_source='termination.refund' THEN
 SELECT o.termination_id INTO term_id FROM public.termination_refund_obligations o WHERE o.voucher_id=v.id AND o.organization_id=p_organization_id
 GROUP BY o.termination_id HAVING (SELECT count(DISTINCT x.termination_id) FROM public.termination_refund_obligations x WHERE x.voucher_id=v.id AND x.organization_id=p_organization_id)=1;
 END IF;
 END IF;
 IF p_source_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.income_expenses x WHERE x.id=p_source_receipt_id AND x.organization_id=p_organization_id AND x.deleted_at IS NULL AND (v_contract_id IS NULL OR x.contract_id=v_contract_id OR EXISTS(SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=x.id AND l.contract_id=v_contract_id AND l.organization_id=p_organization_id))) THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
 IF v_contract_id IS NOT NULL THEN
 SELECT * INTO c FROM public.contracts x WHERE x.id=v_contract_id AND x.organization_id=p_organization_id AND x.deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contract unavailable' USING ERRCODE='42501'; END IF;
 v_room_id:=COALESCE(v_room_id,c.room_id);
 IF v_room_id IS DISTINCT FROM c.room_id AND NOT EXISTS(SELECT 1 FROM public.get_room_residence_segments_v1(ARRAY[c.id]) s WHERE s.room_id=v_room_id AND s.trusted AND s.diagnostic IS NULL) THEN RAISE EXCEPTION 'Residence unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_source_receipt_id IS NOT NULL AND v_contract_id IS NULL AND v_room_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.income_expenses x WHERE x.id=p_source_receipt_id AND x.room_id=v_room_id AND x.organization_id=p_organization_id) THEN RAISE EXCEPTION 'Source room mismatch' USING ERRCODE='42501'; END IF;
 IF v_room_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id WHERE r.id=v_room_id AND r.organization_id=p_organization_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id))) THEN RAISE EXCEPTION 'Room unavailable' USING ERRCODE='42501'; END IF;
 IF term_id IS NOT NULL AND v.id IS NOT NULL AND v.system_source='termination.refund' AND EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.voucher_id=v.id AND o.organization_id=p_organization_id AND o.termination_id<>term_id) THEN RAISE EXCEPTION 'Refund termination mismatch' USING ERRCODE='42501'; END IF;
 IF term_id IS NOT NULL THEN
 SELECT * INTO t FROM public.contract_terminations x WHERE x.id=term_id AND x.contract_id=v_contract_id AND x.organization_id=p_organization_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Termination unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO ob FROM public.termination_refund_obligations x WHERE x.termination_id=term_id AND x.contract_id=v_contract_id AND x.organization_id=p_organization_id AND (p_voucher_id IS NULL OR x.voucher_id=p_voucher_id) ORDER BY x.version DESC LIMIT 1;
 END IF;
 SELECT COALESCE(array_agg(s),'{}') INTO ids FROM app_private.settlement_financial_source_ids_v1(p_organization_id,v_contract_id,p_source_receipt_id) s;
 SELECT COALESCE(array_agg(x.id),'{}') INTO visible_ids FROM public.income_expenses x WHERE x.id=ANY(ids) AND x.organization_id=p_organization_id;
 evidence:=app_private.settlement_financial_evidence_v1(p_organization_id,visible_ids,v_contract_id);
 invoices_complete:=v_contract_id IS NOT NULL AND jsonb_array_length(evidence->'invoiceIds')=(SELECT count(*) FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.contract_id=v_contract_id AND i.deleted_at IS NULL);
 voucher_items_complete:=p_voucher_id IS NOT NULL
  AND COALESCE((evidence->'vouchers'->p_voucher_id::text->>'itemCount')::integer,-1)=(SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id=p_voucher_id AND i.organization_id=p_organization_id);
 IF term_id IS NOT NULL THEN
  breakdown:=app_private.settlement_termination_breakdown_v1(p_organization_id,v_contract_id,term_id,CASE WHEN v.system_source='termination.refund' THEN v.id ELSE NULL END,invoices_complete,voucher_items_complete);
 END IF;
 SELECT jsonb_build_object('schemaVersion',1,'organizationId',p_organization_id,'roomId',v_room_id,'targetContractId',v_contract_id,'terminationId',term_id,'voucherId',p_voucher_id,'sourceReceiptId',p_source_receipt_id,'today',public.org_today_v1(p_organization_id),'generatedAt',now(),
 'receiptsComplete',(v_contract_id IS NOT NULL OR p_source_receipt_id IS NOT NULL) AND cardinality(ids)=cardinality(visible_ids) AND NOT (evidence->>'externalUnknown')::boolean
 AND NOT EXISTS(SELECT 1 FROM public.income_expenses x WHERE x.id=ANY(visible_ids) AND x.system_source='termination.refund' AND term_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.voucher_id=x.id AND o.organization_id=p_organization_id AND o.contract_id=v_contract_id)),
 'invoicesComplete',invoices_complete,
 'depositRequired',c.total_deposit,
 'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'organizationId',x.organization_id,'type',x.type,'amount',x.total_amount,'approvalStatus',x.approval_status,'postingStatus',x.posting_status,'postingMode',x.posting_mode,'accountId',x.account_id,'activePostingId',x.active_posting_id_v2,'sourceVerified',(x.contract_id IS NULL OR x.contract_id=v_contract_id OR v_contract_id IS NULL),
 'isTargetRefund',COALESCE(x.system_source='termination.refund',false) AND EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.voucher_id=x.id AND o.termination_id=term_id AND o.contract_id=v_contract_id AND o.organization_id=p_organization_id),
 'itemsComplete',(evidence->'vouchers'->x.id::text->>'itemCount')::integer=(SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id=x.id AND i.organization_id=p_organization_id),
 'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'accountingClass',i.accounting_class,'amount',COALESCE(i.amount,i.unit_price*i.quantity))) FROM public.income_expense_items i WHERE i.income_expense_id=x.id AND i.organization_id=p_organization_id),'[]'),
 'ledger',evidence->'vouchers'->x.id::text->'ledger')) FROM public.income_expenses x WHERE x.id=ANY(visible_ids)),'[]'),
 'invoices',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'status',i.status,'total',i.total_amount,'paid',i.paid_amount,'remaining',i.remaining_amount,'previousDebt',i.previous_debt,'previousSources',COALESCE(i.previous_debt_sources,'[]'))) FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.contract_id=v_contract_id AND i.deleted_at IS NULL),'[]'),
 'termination',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'contractId',t.contract_id,'date',t.termination_date,'debt',t.outstanding_debt,'status',t.status,'notes',t.notes) END,
 'terminationBreakdown',breakdown,
 'obligation',CASE WHEN ob.id IS NULL THEN NULL ELSE jsonb_build_object('id',ob.id,'terminationId',ob.termination_id,'version',ob.version,'amount',ob.requested_amount,'status',ob.obligation_status,'fingerprint',ob.basis_fingerprint) END,
 'notes',jsonb_build_object('contractNumber',c.contract_number,'roomName',(SELECT name FROM public.rooms WHERE id=v_room_id),'signedDate',c.signed_date,'startDate',c.start_date,'endDate',c.end_date,'rentPrice',c.rent_price,'voucherNotes',v.notes)) INTO result;
 RETURN result;
END $fn$;

GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid) TO authenticated;

COMMIT;
NOTIFY pgrst,'reload schema';
