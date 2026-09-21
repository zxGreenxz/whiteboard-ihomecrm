-- Exact target financial context; public rows use authenticated RLS, ledger bridge is private.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolinherit)
 OR NOT pg_has_role('ie_action_snapshot_reader','authenticated','USAGE') OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Financial reader role drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='ie_action_snapshot_reader'::regrole AND member<>'postgres'::regrole)
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='ie_action_snapshot_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option)) THEN RAISE EXCEPTION 'Financial reader membership drift'; END IF;
 IF to_regprocedure('app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)') IS NOT NULL AND (md5(pg_get_functiondef(to_regprocedure('app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)'))) <> 'e2a106e767e060d7b9540673d6134cae' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)')) <> 'postgres') THEN RAISE EXCEPTION 'Financial function definition/owner drift'; END IF;
 IF to_regprocedure('app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)') IS NOT NULL AND (md5(pg_get_functiondef(to_regprocedure('app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)'))) <> '9cadfa6a7a2c2864ed99c26fe2ab763e' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)')) <> 'postgres') THEN RAISE EXCEPTION 'Financial function definition/owner drift'; END IF;
 IF to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)') IS NOT NULL AND (md5(pg_get_functiondef(to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)'))) <> 'd90aa180120852f3f38a7a0b32c5ad2f' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)')) <> 'ie_action_snapshot_reader') THEN RAISE EXCEPTION 'Financial function definition/owner drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.proname IN ('settlement_financial_source_ids_v1','settlement_financial_evidence_v1','read_contract_settlement_financial_facts_v1') AND (a.is_grantable OR a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole) AND NOT (p.proname='read_contract_settlement_financial_facts_v1' AND a.grantee='authenticated'::regrole))) THEN RAISE EXCEPTION 'Financial function ACL drift'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION app_private.settlement_financial_source_ids_v1(p_org uuid,p_contract uuid,p_source uuid)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_org);
 RETURN QUERY SELECT DISTINCT v.id FROM public.income_expenses v
 WHERE v.organization_id=p_org AND v.deleted_at IS NULL AND (
 v.id=p_source OR v.contract_id=p_contract
 OR EXISTS(SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id AND l.contract_id=p_contract AND l.organization_id=p_org)
 OR EXISTS(SELECT 1 FROM public.invoices i WHERE i.contract_id=p_contract AND i.organization_id=p_org AND (i.id=v.invoice_id
 OR EXISTS(SELECT 1 FROM public.payments p WHERE p.id=v.payment_id AND p.invoice_id=i.id AND p.organization_id=p_org)
 OR EXISTS(SELECT 1 FROM public.invoice_payment_collections c JOIN public.invoice_payment_tenders t ON t.collection_id=c.id AND t.organization_id=p_org WHERE c.invoice_id=i.id AND c.organization_id=p_org AND t.voucher_id=v.id))));
END $fn$;
CREATE OR REPLACE FUNCTION app_private.settlement_financial_evidence_v1(p_org uuid,p_ids uuid[],p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_org);
 SELECT jsonb_build_object('invoiceIds',COALESCE((SELECT jsonb_agg(i.id) FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=p_contract AND i.deleted_at IS NULL),'[]'),
 'externalUnknown',EXISTS(SELECT 1 FROM public.payments pay JOIN public.invoices inv ON inv.id=pay.invoice_id AND inv.organization_id=p_org WHERE inv.contract_id=p_contract AND pay.organization_id=p_org AND pay.reversed_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.income_expenses rv WHERE rv.payment_id=pay.id AND rv.organization_id=p_org AND rv.deleted_at IS NULL)) OR EXISTS(SELECT 1 FROM public.income_expense_postings p WHERE p.organization_id=p_org AND p.voucher_id IS NULL AND (p.external_source_id=p_contract OR p.posting_subject_id=p_contract OR EXISTS(SELECT 1 FROM public.invoices i WHERE i.contract_id=p_contract AND i.organization_id=p_org AND (i.id=p.external_source_id OR EXISTS(SELECT 1 FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.organization_id=p_org AND c.id=p.external_source_id))))),
 'vouchers',COALESCE((SELECT jsonb_object_agg(v.id,jsonb_build_object(
 'itemCount',(SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id=v.id),
 'ledger',jsonb_build_object('netEffect',(SELECT COALESCE(sum(p.net_cash_effect),0) FROM public.income_expense_postings p WHERE p.voucher_id=v.id AND p.organization_id=p_org),
 'allPostingsVirtual',COALESCE((SELECT bool_and(COALESCE(a.is_virtual,false)) FROM public.income_expense_postings p LEFT JOIN public.accounts a ON a.id=p.account_id AND a.organization_id=p_org WHERE p.voucher_id=v.id AND p.organization_id=p_org),false),
 'active',(SELECT jsonb_build_object('id',p.id,'voucherId',p.voucher_id,'organizationId',p.organization_id,'accountId',p.account_id,'amount',p.voucher_amount_snapshot,'netEffect',p.net_cash_effect,'virtual',a.is_virtual,'reversed',(p.event_kind<>'POSTING' OR p.reversal_of_id IS NOT NULL) OR EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=p.id)) FROM public.income_expense_postings p JOIN public.accounts a ON a.id=p.account_id AND a.organization_id=p_org WHERE p.id=v.active_posting_id_v2 AND p.voucher_id=v.id AND p.organization_id=p_org)))) FROM public.income_expenses v WHERE v.id=ANY(p_ids) AND v.organization_id=p_org),'{}')) INTO result;
 RETURN result;
END $fn$;
ALTER FUNCTION app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid),app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid),app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid) TO ie_action_snapshot_reader;
CREATE OR REPLACE FUNCTION public.read_contract_settlement_financial_facts_v1(p_organization_id uuid,p_room_id uuid DEFAULT NULL,p_contract_id uuid DEFAULT NULL,p_termination_id uuid DEFAULT NULL,p_voucher_id uuid DEFAULT NULL,p_source_receipt_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET row_security=on AS $fn$
DECLARE c public.contracts; v public.income_expenses; t public.contract_terminations; ob public.termination_refund_obligations;
 ids uuid[]; visible_ids uuid[]; evidence jsonb; result jsonb; term_id uuid:=p_termination_id; v_contract_id uuid:=p_contract_id; v_room_id uuid:=p_room_id;
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
 SELECT jsonb_build_object('schemaVersion',1,'organizationId',p_organization_id,'roomId',v_room_id,'targetContractId',v_contract_id,'terminationId',term_id,'voucherId',p_voucher_id,'sourceReceiptId',p_source_receipt_id,'today',public.org_today_v1(p_organization_id),'generatedAt',now(),
 'receiptsComplete',(v_contract_id IS NOT NULL OR p_source_receipt_id IS NOT NULL) AND cardinality(ids)=cardinality(visible_ids) AND NOT (evidence->>'externalUnknown')::boolean
 AND NOT EXISTS(SELECT 1 FROM public.income_expenses x WHERE x.id=ANY(visible_ids) AND x.system_source='termination.refund' AND term_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.voucher_id=x.id AND o.organization_id=p_organization_id AND o.contract_id=v_contract_id)),
 'invoicesComplete',v_contract_id IS NOT NULL AND jsonb_array_length(evidence->'invoiceIds')=(SELECT count(*) FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.contract_id=v_contract_id AND i.deleted_at IS NULL),
 'depositRequired',c.total_deposit,
 'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'organizationId',x.organization_id,'type',x.type,'amount',x.total_amount,'approvalStatus',x.approval_status,'postingStatus',x.posting_status,'postingMode',x.posting_mode,'accountId',x.account_id,'activePostingId',x.active_posting_id_v2,'sourceVerified',(x.contract_id IS NULL OR x.contract_id=v_contract_id OR v_contract_id IS NULL),
 'isTargetRefund',COALESCE(x.system_source='termination.refund',false) AND EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.voucher_id=x.id AND o.termination_id=term_id AND o.contract_id=v_contract_id AND o.organization_id=p_organization_id),
 'itemsComplete',(evidence->'vouchers'->x.id::text->>'itemCount')::integer=(SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id=x.id AND i.organization_id=p_organization_id),
 'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'accountingClass',i.accounting_class,'amount',COALESCE(i.amount,i.unit_price*i.quantity))) FROM public.income_expense_items i WHERE i.income_expense_id=x.id AND i.organization_id=p_organization_id),'[]'),
 'ledger',evidence->'vouchers'->x.id::text->'ledger')) FROM public.income_expenses x WHERE x.id=ANY(visible_ids)),'[]'),
 'invoices',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'status',i.status,'total',i.total_amount,'paid',i.paid_amount,'remaining',i.remaining_amount,'previousDebt',i.previous_debt,'previousSources',COALESCE(i.previous_debt_sources,'[]'))) FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.contract_id=v_contract_id AND i.deleted_at IS NULL),'[]'),
 'termination',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'contractId',t.contract_id,'date',t.termination_date,'debt',t.outstanding_debt,'status',t.status,'notes',t.notes) END,
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
