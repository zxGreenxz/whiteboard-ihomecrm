-- Authenticated complete-set reader. No write, lock, or action authorization.
CREATE OR REPLACE FUNCTION public.read_contract_settlement_page_v1(
 p_organization_id uuid, p_building_ids uuid[], p_cursor text DEFAULT NULL,
 p_revision text DEFAULT NULL, p_limit integer DEFAULT 250
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_rows jsonb; v_revision text; v_page jsonb; v_next text;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=p_organization_id
   AND m.user_id=auth.uid() AND m.status='ACTIVE' AND coalesce(m.valid_from,'-infinity'::timestamptz)<=now()
   AND EXISTS (SELECT 1 FROM public.organizations org WHERE org.id=m.organization_id AND org.status='ACTIVE')
   AND (m.valid_to IS NULL OR m.valid_to>now())
 ) THEN RAISE EXCEPTION 'Active organization membership required' USING ERRCODE='42501'; END IF;
 IF p_building_ids IS NULL OR cardinality(p_building_ids)=0 OR p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
  RAISE EXCEPTION 'Invalid reader scope or page size' USING ERRCODE='22023'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(p_building_ids) requested(id) LEFT JOIN public.buildings b ON b.id=requested.id
  WHERE b.id IS NULL OR b.organization_id IS DISTINCT FROM p_organization_id OR b.deleted_at IS NOT NULL
   OR NOT app_private.building_org_visible_v1(b.id)
   OR NOT (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id))) THEN
  RAISE EXCEPTION 'Building scope denied' USING ERRCODE='42501'; END IF;
 WITH scoped_vouchers AS MATERIALIZED (
  SELECT ie.*, CASE WHEN ie.commission_kind='sale' THEN 'bonus' WHEN ie.system_source IN ('termination.refund','reservation.refund') THEN 'refund' ELSE 'commission' END AS kind
  FROM public.income_expenses ie
  WHERE ie.organization_id=p_organization_id AND ie.building_id=ANY(p_building_ids)
   AND ie.deleted_at IS NULL AND ie.type='EXPENSE'
   AND (ie.commission_kind IN ('broker','sale') OR ie.system_source IN ('termination.refund','reservation.refund')
    OR (ie.commission_kind IS NULL AND EXISTS (SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types tp ON tp.id=i.income_expense_type_id WHERE i.income_expense_id=ie.id AND public.nrm_vn(tp.name) LIKE '%hoa hong%')))
   AND (NOT ie.has_restricted_item OR ie.user_id=auth.uid() OR public.can_view_restricted_ie())
   AND NOT ((public.is_admin() OR public.is_super_admin()) AND ie.user_id=ANY(public.demo_user_ids()))
 ), contracts AS MATERIALIZED (
  SELECT c.*, r.building_id, r.name AS room_name,
   (SELECT cust.full_name FROM public.contract_customers cc JOIN public.customers cust ON cust.id=cc.customer_id
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC NULLS LAST, cc.id LIMIT 1) customer_name
  FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id
  WHERE c.organization_id=p_organization_id AND r.building_id=ANY(p_building_ids) AND c.deleted_at IS NULL
   AND NOT ((public.is_admin() OR public.is_super_admin()) AND c.user_id=ANY(public.demo_user_ids()))
 ), obligations AS MATERIALIZED (
  SELECT o.*, t.termination_date, c.building_id,c.room_id,c.room_name,c.contract_number,c.customer_name,
   row_number() OVER (PARTITION BY o.termination_id ORDER BY o.version DESC,o.id) rank
  FROM public.termination_refund_obligations o JOIN public.contract_terminations t ON t.id=o.termination_id AND t.organization_id=o.organization_id
   JOIN contracts c ON c.id=t.contract_id AND c.id=o.contract_id
  WHERE o.organization_id=p_organization_id
 ), vouchers AS (
  SELECT v.*,c.contract_number,c.room_name,c.customer_name,c.signed_date,
   link.ref, link.event_date, link.amount basis_amount, link.fingerprint, link.version basis_version,
   (SELECT own.lifecycle_owner FROM app_private.income_expense_flow_ownership own
    WHERE own.income_expense_id=v.id AND own.organization_id=v.organization_id) owner,
   posting.id evidence_id,posting.posted_on,
   (SELECT -coalesce(sum(p.net_cash_effect),0) FROM public.income_expense_postings p
    WHERE p.voucher_id=v.id AND p.organization_id=v.organization_id) net_paid
  FROM scoped_vouchers v LEFT JOIN contracts c ON c.id=v.contract_id
  LEFT JOIN public.income_expense_postings posting ON posting.id=v.active_posting_id_v2 AND posting.voucher_id=v.id AND posting.organization_id=v.organization_id
  LEFT JOIN LATERAL (
   SELECT CASE WHEN count(*)=1 THEN jsonb_agg(candidate.ref)->0 END ref,
    CASE WHEN count(*)=1 THEN min(candidate.event_date) END event_date,
    CASE WHEN count(*)=1 THEN min(candidate.amount) END amount,
    CASE WHEN count(*)=1 THEN min(candidate.fingerprint) END fingerprint,
    CASE WHEN count(*)=1 THEN min(candidate.version) END version
   FROM (
   SELECT jsonb_build_object('kind','broker','organizationId',v.organization_id,'contractId',c.id) ref,
    c.signed_date event_date,NULL::numeric amount,NULL::text fingerprint,NULL::integer version
   WHERE v.kind='commission' AND c.id IS NOT NULL
   UNION ALL
   SELECT jsonb_build_object('kind','sale_deposit','organizationId',v.organization_id,'depositVoucherId',s.deposit_voucher_id),
    dep.voucher_date,s.amount,NULL,NULL
   FROM app_private.sale_bonus_claims s JOIN public.income_expenses dep ON dep.id=s.deposit_voucher_id AND dep.organization_id=s.organization_id
   WHERE v.kind='bonus' AND s.bonus_voucher_id=v.id AND s.organization_id=v.organization_id AND dep.building_id=ANY(p_building_ids)
   UNION ALL
   SELECT jsonb_build_object('kind','sale_contract','organizationId',v.organization_id,'contractId',c.id),c.signed_date,NULL,NULL,NULL
   WHERE v.kind='bonus' AND c.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_private.sale_bonus_claims s WHERE s.bonus_voucher_id=v.id AND s.deposit_voucher_id IS NOT NULL)
   UNION ALL
   SELECT jsonb_build_object('kind','termination_refund','organizationId',v.organization_id,'terminationId',o.termination_id,'obligationId',o.id,'obligationVersion',o.version),o.termination_date,o.requested_amount,o.basis_fingerprint,o.version
   FROM obligations o WHERE v.system_source='termination.refund' AND o.voucher_id=v.id
    AND (SELECT count(*) FROM obligations x WHERE x.voucher_id=v.id)=1
   UNION ALL
   SELECT jsonb_build_object('kind','termination_refund','organizationId',v.organization_id,'terminationId',t.id,'obligationId',NULL,'obligationVersion',NULL),t.termination_date,NULL,NULL,NULL
   FROM public.contract_terminations t WHERE v.system_source='termination.refund' AND t.contract_id=c.id AND t.organization_id=v.organization_id
    AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.voucher_id=v.id)
    AND (SELECT count(*) FROM public.contract_terminations t2 WHERE t2.contract_id=c.id AND t2.organization_id=v.organization_id)=1
    AND (SELECT count(*) FROM public.income_expenses x WHERE x.contract_id=c.id AND x.organization_id=v.organization_id AND x.system_source='termination.refund' AND x.deleted_at IS NULL)=1
   UNION ALL
   SELECT jsonb_build_object('kind','reservation_refund','organizationId',v.organization_id,'sourceVoucherId',s.source_voucher_id,'settlementId',s.id,'refundVoucherId',v.id),s.settlement_date,s.refund_amount,s.basis_fingerprint,NULL
   FROM public.reservation_deposit_settlements s WHERE v.system_source='reservation.refund'
    AND (s.refund_voucher_id=v.id OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers l WHERE l.settlement_id=s.id AND l.organization_id=s.organization_id AND l.voucher_id=v.id AND l.kind='REFUND'))
    AND s.organization_id=v.organization_id AND s.building_id=ANY(p_building_ids)
   ) candidate
  ) link ON true
 ), voucher_rows AS (
  SELECT jsonb_build_object('rowType','voucher','rowKey','voucher:'||v.id,'settlementKind',v.kind,'voucherId',v.id,'voucherCode',v.code,
   'sourceLink',CASE WHEN v.ref IS NULL THEN jsonb_build_object('state','unverified','reason','SOURCE_LINK_MISSING_OR_CONFLICT') ELSE jsonb_build_object('state','verified','sourceRef',v.ref) END,
   'basis',jsonb_build_object('kind',CASE WHEN v.kind='commission' THEN 'COMMISSION' WHEN v.kind='bonus' THEN 'SALE_BONUS' WHEN v.system_source='reservation.refund' THEN 'RESERVATION_REFUND' ELSE 'TERMINATION_REFUND' END,
    'status',CASE WHEN v.basis_amount IS NULL THEN 'MISSING' ELSE 'AVAILABLE' END,'amount',v.basis_amount,'measuredAt',NULL,'source','authenticated_reader','fingerprint',nullif(v.fingerprint,''),'version',v.basis_version,'warning',NULL),
   'snapshot',jsonb_build_object('state','ready','value',jsonb_build_object(
    'id',v.id,'code',v.code,'organizationId',v.organization_id,'buildingId',v.building_id,'roomId',v.room_id,'roomName',nullif(coalesce(v.room_name,(SELECT r.name FROM public.rooms r WHERE r.id=v.room_id AND r.building_id=v.building_id)),''),
    'contractId',v.contract_id,'contractNumber',nullif(v.contract_number,''),'tenantId',v.tenant_id,'customerName',nullif(v.customer_name,''),
    'totalAmount',v.total_amount,'type',v.type,'payerName',nullif(v.payer_name,''),'receiveBankName',nullif(v.receive_bank_name,''),'receiveBankAccount',nullif(v.receive_bank_account,''),'accountId',v.account_id,
    'approvalStatus',v.approval_status,'postingStatus',v.posting_status,'postingMode',v.posting_mode,'reviewState',v.review_state,'reviewReason',nullif(v.review_reason,''),
    'approvalVersion',v.approval_version,'postingVersion',v.posting_version,'reviewVersion',v.review_version,'systemSource',nullif(v.system_source,''),'activePostingId',v.active_posting_id_v2,'effectiveNetPaid',v.net_paid,'postedOn',v.posted_on,
    'voucherDate',v.voucher_date,'sourceEventDate',v.event_date,'makerUserId',v.maker_user_id,
    'flowOwnership',jsonb_build_object('state','ready','value',jsonb_build_object('owner',v.owner,'verified',true)),
    'postingEvidence',jsonb_build_object('state','ready','value',jsonb_build_object('activePostingId',v.evidence_id,'effectiveNetPaid',v.net_paid,'postedOn',v.posted_on)),
    'notes',nullif(v.notes,''),'attachments',coalesce(to_jsonb(v.attachments),'[]'::jsonb),'actionReadiness',jsonb_build_object('state','loading')))) row
  FROM vouchers v
 ), source_basis AS (
  SELECT c.id,c.organization_id,c.building_id,c.room_id,c.room_name,c.contract_number,c.customer_name,c.signed_date event_date,
   'commission' kind,'COMMISSION' basis_kind,jsonb_build_object('kind','broker','organizationId',c.organization_id,'contractId',c.id) ref,
   CASE WHEN c.rent_price IS NULL THEN NULL ELSE round(c.rent_price * app_private.commission_rate_for_v1(c.organization_id,c.building_id,
    greatest(0,(extract(year from age(c.end_date,c.start_date))*12+extract(month from age(c.end_date,c.start_date)))::int),public.org_today_v1(c.organization_id))/100) END amount,
   NULL::text fingerprint,NULL::integer version,NULL::text warning,'broker:'||c.id row_key
  FROM contracts c WHERE c.signed_date IS NOT NULL AND c.status::text IN ('ACTIVE','EXPIRED','TERMINATED')
   AND NOT EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.contract_id=c.id AND v.organization_id=c.organization_id AND v.deleted_at IS NULL
    AND (v.commission_kind='broker' OR (v.commission_kind IS NULL AND EXISTS (
     SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types tp ON tp.id=i.income_expense_type_id WHERE i.income_expense_id=v.id AND public.nrm_vn(tp.name) LIKE '%hoa hong%'))))
  UNION ALL
  SELECT o.contract_id,o.organization_id,o.building_id,o.room_id,o.room_name,o.contract_number,o.customer_name,o.termination_date,
   'refund','TERMINATION_REFUND',jsonb_build_object('kind','termination_refund','organizationId',o.organization_id,'terminationId',o.termination_id,'obligationId',o.id,'obligationVersion',o.version),
   o.requested_amount,o.basis_fingerprint,o.version,o.warning,'termination:'||o.termination_id
  FROM obligations o WHERE o.rank=1 AND o.voucher_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM obligations x WHERE x.termination_id=o.termination_id AND x.voucher_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.contract_id=o.contract_id AND v.organization_id=o.organization_id AND v.system_source='termination.refund' AND v.deleted_at IS NULL)
  UNION ALL
  SELECT c.id,c.organization_id,c.building_id,c.room_id,c.room_name,c.contract_number,c.customer_name,t.termination_date,
   'refund','TERMINATION_REFUND',jsonb_build_object('kind','termination_refund','organizationId',c.organization_id,'terminationId',t.id,'obligationId',NULL,'obligationVersion',NULL),
   NULL::numeric,NULL::text,NULL::integer,'REFUND_BASIS_REQUIRED','termination:'||t.id
  FROM public.contract_terminations t JOIN contracts c ON c.id=t.contract_id AND c.organization_id=t.organization_id
  WHERE t.status IN ('APPROVED','COMPLETED')
   AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.termination_id=t.id)
   AND NOT EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.contract_id=c.id AND v.organization_id=c.organization_id AND v.system_source='termination.refund' AND v.deleted_at IS NULL)
  UNION ALL
  SELECT NULL::uuid,s.organization_id,s.building_id,s.room_id,r.name,NULL::text,NULL::text,s.settlement_date,
   'refund','RESERVATION_REFUND',jsonb_build_object('kind','reservation_refund','organizationId',s.organization_id,'sourceVoucherId',s.source_voucher_id,'settlementId',s.id,'refundVoucherId',NULL),
   s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id),s.basis_fingerprint,NULL::integer,NULL::text,'reservation:'||s.id
  FROM public.reservation_deposit_settlements s LEFT JOIN public.rooms r ON r.id=s.room_id AND r.building_id=s.building_id
  WHERE s.organization_id=p_organization_id AND s.building_id=ANY(p_building_ids)
   AND app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id)
   AND s.refund_amount>app_private.reservation_settlement_refunded_v1(s.id) AND s.refund_voucher_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers l WHERE l.settlement_id=s.id AND l.organization_id=s.organization_id AND l.kind='REFUND')
 ), source_rows AS (
  SELECT jsonb_build_object('rowType','source','rowKey',s.row_key,'settlementKind',s.kind,'sourceRef',s.ref,
   'organizationId',s.organization_id,'buildingId',s.building_id,'roomId',s.room_id,'roomName',nullif(s.room_name,''),'contractId',s.id,'contractNumber',nullif(s.contract_number,''),'customerName',nullif(s.customer_name,''),'eventDate',s.event_date,
   'recipient',jsonb_build_object('name',NULL,'bankName',NULL,'bankAccount',NULL),
   'basis',jsonb_build_object('kind',s.basis_kind,'status',CASE WHEN s.amount IS NULL THEN 'MISSING' ELSE 'AVAILABLE' END,'amount',s.amount,'measuredAt',NULL,'source','authenticated_reader','fingerprint',nullif(s.fingerprint,''),'version',s.version,'warning',nullif(s.warning,'')),
   'createEligibility',jsonb_build_object('state','unavailable','reasonCodes',jsonb_build_array('SOURCE_ADAPTER_REQUIRED'))) row FROM source_basis s
 )
 SELECT coalesce(jsonb_agg(row ORDER BY row->>'rowKey'),'[]'::jsonb) INTO v_rows FROM (SELECT row FROM voucher_rows UNION ALL SELECT row FROM source_rows) all_rows;
 v_revision:=md5(v_rows::text || auth.uid()::text || p_organization_id::text);
 IF p_revision IS NOT NULL AND p_revision<>v_revision THEN RAISE EXCEPTION 'SETTLEMENT_CHANGED_RELOAD' USING ERRCODE='PT409'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'rowKey'),'[]'::jsonb) INTO v_page FROM (
  SELECT value FROM jsonb_array_elements(v_rows) WHERE p_cursor IS NULL OR value->>'rowKey'>p_cursor ORDER BY value->>'rowKey' LIMIT p_limit
 ) page;
 SELECT max(value->>'rowKey') INTO v_next FROM jsonb_array_elements(v_page);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) WHERE value->>'rowKey'>v_next) THEN v_next:=NULL; END IF;
 RETURN jsonb_build_object('rows',v_page,'nextCursor',v_next,'revision',v_revision,'asOf',statement_timestamp());
END $fn$;
REVOKE ALL ON FUNCTION public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer) TO authenticated;
COMMENT ON FUNCTION public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer) IS 'Scoped read-only settlement rows. All pages require the same content revision; this is not a cross-request transaction. Source actions require their own authenticated adapter.';
