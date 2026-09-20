-- Business events retain source identities. Financial legs never multiply events.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolinherit)
 OR NOT pg_has_role('ie_action_snapshot_reader','authenticated','USAGE')
 OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE')
 OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Event reader role prerequisite/drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='ie_action_snapshot_reader'::regrole AND member<>'postgres'::regrole)
 OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='ie_action_snapshot_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option)) THEN RAISE EXCEPTION 'Event reader membership drift'; END IF;
 IF to_regprocedure('public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)') IS NOT NULL
 AND md5(pg_get_functiondef(to_regprocedure('public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)')))<>'111961b0e0700535acfe0af478ed2ea4' THEN RAISE EXCEPTION 'Event reader definition drift'; END IF;
 IF to_regprocedure('app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)') IS NOT NULL
 AND md5(pg_get_functiondef(to_regprocedure('app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)')))<>'f9bd5633ff3791052b39a5166166878c' THEN RAISE EXCEPTION 'Event private helper definition drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure('public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)')
 AND (p.proowner<>'ie_action_snapshot_reader'::regrole OR a.is_grantable OR a.grantee NOT IN ('ie_action_snapshot_reader'::regrole,'authenticated'::regrole))) THEN RAISE EXCEPTION 'Event reader ACL/owner drift'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure('app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)')
 AND (p.proowner<>'postgres'::regrole OR a.is_grantable OR a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole))) THEN RAISE EXCEPTION 'Event private helper ACL/owner drift'; END IF;
END
$guard$;

-- Only the non-bypass reader can ask for candidate identities. Public output joins
-- them back through real income_expenses RLS, and reports incomplete coverage when
-- any candidate is hidden. No private claim ID, hidden voucher ID or count escapes.
CREATE OR REPLACE FUNCTION app_private.settlement_event_expense_ids_v1(
 p_organization_id uuid,p_building_id uuid,p_contract_ids uuid[],p_source_voucher_id uuid
) RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_ids uuid[];
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_organization_id);
 IF cardinality(p_contract_ids)>2 OR NOT EXISTS (SELECT 1 FROM public.buildings b WHERE b.id=p_building_id
  AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND app_private.building_org_visible_v1(b.id)
  AND (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id))) THEN
  RAISE EXCEPTION 'Event scope denied' USING ERRCODE='42501'; END IF;
 SELECT coalesce(array_agg(v.id ORDER BY v.id),'{}'::uuid[]) INTO v_ids
 FROM public.income_expenses v WHERE v.organization_id=p_organization_id AND v.building_id=p_building_id
 AND v.type='EXPENSE' AND v.deleted_at IS NULL AND (
  (v.contract_id=ANY(p_contract_ids) AND (v.commission_kind IN ('broker','sale') OR v.system_source='termination.refund'
   OR (v.commission_kind IS NULL AND EXISTS (SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
    WHERE i.income_expense_id=v.id AND public.nrm_vn(t.name) LIKE '%hoa hong%'))))
  OR (p_source_voucher_id IS NOT NULL AND EXISTS (SELECT 1 FROM app_private.sale_bonus_claims s WHERE s.organization_id=p_organization_id
   AND s.deposit_voucher_id=p_source_voucher_id AND s.bonus_voucher_id=v.id))
  OR (p_source_voucher_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.organization_id=p_organization_id
   AND s.source_voucher_id=p_source_voucher_id AND (s.refund_voucher_id=v.id OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers l
    WHERE l.organization_id=s.organization_id AND l.settlement_id=s.id AND l.voucher_id=v.id AND l.kind='REFUND'))))
 );
 RETURN v_ids;
END
$fn$;
ALTER FUNCTION app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid) TO ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION public.read_contract_settlement_events_v1(
 p_organization_id uuid,p_building_ids uuid[],p_cursor text DEFAULT NULL,p_revision text DEFAULT NULL,p_limit integer DEFAULT 250
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private SET row_security=on
AS $fn$
DECLARE v_rows jsonb; v_page jsonb; v_revision text; v_next text; v_scope jsonb;
BEGIN
 v_scope:=app_private.income_expense_action_scope_v1(p_organization_id);
 IF p_building_ids IS NULL OR cardinality(p_building_ids)=0 OR cardinality(p_building_ids)>1000
 OR array_position(p_building_ids,NULL) IS NOT NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>250 THEN
  RAISE EXCEPTION 'Invalid event reader scope' USING ERRCODE='22023'; END IF;
 IF EXISTS (SELECT 1 FROM unnest(p_building_ids) requested(id) LEFT JOIN public.buildings b
  ON b.id=requested.id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL WHERE b.id IS NULL) THEN
  RAISE EXCEPTION 'Event building scope denied' USING ERRCODE='42501'; END IF;
 WITH visible_contracts AS MATERIALIZED (
  SELECT c.*,r.building_id,r.name AS room_name,
   (SELECT cu.full_name FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id AND cc.organization_id=c.organization_id ORDER BY cc.is_representative DESC NULLS LAST,cc.id LIMIT 1) customer_name,
   NULL::text staff_name
  FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
  WHERE c.organization_id=p_organization_id AND r.building_id=ANY(p_building_ids) AND c.deleted_at IS NULL
 ), extensions AS MATERIALIZED (
  SELECT e.*,c.building_id,c.room_id,c.room_name,c.customer_name,c.staff_name,c.contract_number
  FROM public.contract_extensions e JOIN visible_contracts c ON c.id=e.contract_id AND c.organization_id=e.organization_id
  WHERE e.status IN ('APPROVED','COMPLETED')
 ), reservations AS MATERIALIZED (
  SELECT v.*,r.name AS room_name,
   NULL::text staff_name
  FROM public.income_expenses v LEFT JOIN public.rooms r ON r.id=v.room_id AND r.organization_id=v.organization_id AND r.building_id=v.building_id
  WHERE v.organization_id=p_organization_id AND v.building_id=ANY(p_building_ids) AND v.deleted_at IS NULL AND v.type='INCOME'
   AND (v.approval_status='APPROVED' OR v.approved_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id=v.id AND i.accounting_class='DEPOSIT' AND i.amount>0)
   AND (v.contract_id IS NULL
    OR EXISTS (SELECT 1 FROM public.contract_deposit_links l WHERE l.organization_id=v.organization_id AND l.income_expense_id=v.id AND l.link_source='EXPLICIT_V2')
    OR EXISTS (SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.organization_id=v.organization_id AND s.source_voucher_id=v.id))
 ), base AS (
  SELECT 'contract'::text source_kind,c.id source_id,'sign'::text event_type,c.organization_id,c.building_id,c.room_id,c.room_name,
   c.id contract_id,NULL::uuid related_contract_id,NULL::uuid source_voucher_id,c.customer_name,c.staff_name,
   coalesce(c.contract_number,c.public_code) source_code,c.signed_date business_date,'contract'::text origin,
   'Ký hợp đồng'::text description,c.notes,NULL::text warning
  FROM visible_contracts c WHERE c.status::text NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED') AND c.parent_contract_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM extensions e WHERE e.new_contract_id=c.id AND e.extension_type='CREATE_NEW')
  UNION ALL
  SELECT 'extension',e.id,'renew',e.organization_id,e.building_id,e.room_id,e.room_name,e.contract_id,
   e.new_contract_id,NULL,e.customer_name,e.staff_name,coalesce(e.contract_number,e.contract_id::text),e.extension_date,'contract',
   CASE WHEN e.extension_type='CREATE_NEW' THEN 'Gia hạn bằng hợp đồng mới' ELSE 'Gia hạn thời gian thuê' END,e.notes,NULL
  FROM extensions e
  UNION ALL
  SELECT 'termination',t.id,CASE WHEN t.termination_type='FORFEIT' THEN 'forfeit' ELSE 'terminate' END,
   c.organization_id,c.building_id,c.room_id,c.room_name,c.id,NULL,NULL,c.customer_name,c.staff_name,
   coalesce(c.contract_number,c.public_code),t.termination_date,'contract',
   CASE WHEN t.termination_type='FORFEIT' THEN 'Bỏ cọc hợp đồng' ELSE 'Thanh lý hợp đồng' END,t.notes,NULL
  FROM public.contract_terminations t JOIN visible_contracts c ON c.id=t.contract_id AND c.organization_id=t.organization_id
  WHERE t.status IN ('APPROVED','COMPLETED')
  UNION ALL
  SELECT 'reservation',v.id,'reserve',v.organization_id,v.building_id,v.room_id,v.room_name,
   (SELECT c.id FROM visible_contracts c WHERE c.id=v.contract_id),NULL,v.id,v.payer_name,v.staff_name,v.code,v.voucher_date,
   'reservation','Lập hồ sơ cọc giữ chỗ',v.notes,NULL FROM reservations v
  UNION ALL
  SELECT 'reservation_settlement',s.id,CASE WHEN s.retained_amount>0 THEN 'forfeit' ELSE 'terminate' END,
   s.organization_id,s.building_id,s.room_id,r.name,(SELECT c.id FROM visible_contracts c WHERE c.id=v.contract_id),NULL,s.source_voucher_id,
   v.payer_name,NULL::text,
   coalesce(v.code,s.id::text),s.settlement_date,'reservation',
   CASE WHEN s.retained_amount>0 THEN 'Kết thúc giữ chỗ · có phần cọc giữ lại' ELSE 'Kết thúc giữ chỗ · hoàn khách' END,
   s.reason_text,CASE WHEN v.id IS NULL THEN 'Chưa đọc được phiếu cọc nguồn' ELSE NULL END
  FROM public.reservation_deposit_settlements s
  LEFT JOIN public.income_expenses v ON v.id=s.source_voucher_id AND v.organization_id=s.organization_id
  LEFT JOIN public.rooms r ON r.id=s.room_id AND r.building_id=s.building_id AND r.organization_id=s.organization_id
  WHERE s.organization_id=p_organization_id AND s.building_id=ANY(p_building_ids)
 ), candidates AS MATERIALIZED (
  SELECT e.*,app_private.settlement_event_expense_ids_v1(e.organization_id,e.building_id,
   array_remove(ARRAY[e.contract_id,e.related_contract_id],NULL),e.source_voucher_id) voucher_ids FROM base e
 ), rows AS (
  SELECT jsonb_build_object('id',e.source_kind||':'||e.source_id,'sourceKind',e.source_kind,'sourceId',e.source_id,'type',e.event_type,
   'organizationId',e.organization_id,'buildingId',e.building_id,'roomId',e.room_id,'roomName',e.room_name,
   'contractId',e.contract_id,'relatedContractId',e.related_contract_id,'sourceVoucherId',e.source_voucher_id,
   'customerName',e.customer_name,'staffName',e.staff_name,'sourceCode',e.source_code,'businessDate',e.business_date,
   'origin',e.origin,'description',e.description,'notes',e.notes,'warning',e.warning,
   'links',jsonb_build_object('complete',l.visible_count=cardinality(e.voucher_ids),'vouchers',l.vouchers)) value
  FROM candidates e CROSS JOIN LATERAL (
   SELECT count(*) visible_count,coalesce(jsonb_agg(jsonb_build_object('id',v.id,'code',v.code,'amount',v.total_amount,
    'approvalStatus',v.approval_status,'reviewState',v.review_state) ORDER BY v.code,v.id),'[]'::jsonb) vouchers
   FROM public.income_expenses v WHERE v.id=ANY(e.voucher_ids) AND v.organization_id=e.organization_id AND v.building_id=e.building_id
  ) l
 ) SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb) INTO v_rows FROM rows;
 v_revision:=md5(v_rows::text||auth.uid()::text||p_organization_id::text||v_scope::text);
 IF p_revision IS NOT NULL AND p_revision<>v_revision THEN RAISE EXCEPTION 'Event data changed' USING ERRCODE='PT409'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb) INTO v_page
 FROM (SELECT value FROM jsonb_array_elements(v_rows) WHERE p_cursor IS NULL OR value->>'id'>p_cursor ORDER BY value->>'id' LIMIT p_limit) page;
 SELECT max(value->>'id') INTO v_next FROM jsonb_array_elements(v_page);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) WHERE value->>'id'>v_next) THEN v_next:=NULL; END IF;
 RETURN jsonb_build_object('organizationId',p_organization_id,'actorId',auth.uid(),'rows',v_page,'revision',v_revision,'nextCursor',v_next,'asOf',statement_timestamp());
END
$fn$;
GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
