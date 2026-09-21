-- T6 selected-source facts. Reads only; creation remains in the existing domain writers.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND rolinherit) OR pg_has_role('authenticated','ie_action_snapshot_reader','SET') OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Source reader role drift'; END IF;
 IF md5(pg_get_functiondef('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)'::regprocedure))<>'c134aa5857144c2b8f66145f0e9feab5' OR md5(pg_get_functiondef('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)'::regprocedure))<>'fbaed9b582feab422372165eb55a8288' OR NOT (md5(pg_get_functiondef('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)'::regprocedure))='cdc2896ff50e836cb782219683ba5474' OR (md5(pg_get_functiondef('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)'::regprocedure))='79dda3e01cdcdee2d36d55dd7a7df670' AND coalesce(md5(pg_get_functiondef(to_regprocedure('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)'))),'')='9d0ce57d4ccc0818bbdc5aa09e3b56ca')) THEN RAISE EXCEPTION 'Source writer definition drift'; END IF;
 IF to_regprocedure('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)')))<>'f8acf6adaa1e8da590c373735fb4768c' THEN RAISE EXCEPTION 'Source reader definition drift'; END IF;
 IF to_regprocedure('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)')))<>'330d0c496245baa2daba55bed7fbc619' THEN RAISE EXCEPTION 'Source facts definition drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)') AND (proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole) OR a.is_grantable))) THEN RAISE EXCEPTION 'Source facts owner/ACL drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)') AND (proowner<>'ie_action_snapshot_reader'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee NOT IN ('ie_action_snapshot_reader'::regrole,'authenticated'::regrole) OR a.is_grantable))) THEN RAISE EXCEPTION 'Source reader owner/ACL drift'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION app_private.contract_settlement_create_facts_v1(p_org uuid,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $facts$
DECLARE v_contract public.contracts%ROWTYPE; v_dep public.income_expenses%ROWTYPE; v_term public.contract_terminations%ROWTYPE;
 v_building public.buildings%ROWTYPE; v_bld uuid; v_contract_id uuid; v_claims uuid[]; v_allowed boolean; v_cap numeric; v_months integer; v_rate numeric; v_preview jsonb; v_obligation jsonb;
BEGIN
 -- Only the non-bypass public reader has EXECUTE, after checking actual source RLS.
 PERFORM app_private.income_expense_action_scope_v1(p_org);
 IF p_kind IN ('broker','sale_contract') THEN
  SELECT * INTO STRICT v_contract FROM public.contracts WHERE id=p_id AND organization_id=p_org AND deleted_at IS NULL;
  v_contract_id:=v_contract.id;SELECT building_id INTO v_bld FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_org;
 ELSIF p_kind='sale_deposit' THEN
  SELECT * INTO STRICT v_dep FROM public.income_expenses WHERE id=p_id AND organization_id=p_org AND deleted_at IS NULL;
  v_bld:=v_dep.building_id;v_contract_id:=v_dep.contract_id;
 ELSIF p_kind='termination_refund' THEN
  SELECT * INTO STRICT v_term FROM public.contract_terminations WHERE id=p_id AND organization_id=p_org;
  SELECT * INTO STRICT v_contract FROM public.contracts WHERE id=v_term.contract_id AND organization_id=p_org AND deleted_at IS NULL;
  v_contract_id:=v_contract.id;SELECT building_id INTO v_bld FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_org;
 ELSE RAISE EXCEPTION 'Unsupported source kind' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT v_building FROM public.buildings WHERE id=v_bld AND organization_id=p_org AND deleted_at IS NULL;
 -- Mirrors the existing source writers, including broker's building-owner case.
 v_allowed:=public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld) OR public.is_admin() OR public.is_super_admin() OR (p_kind IN ('broker','sale_contract') AND v_building.user_id=auth.uid());
 IF p_kind='broker' THEN
  SELECT array_agg(v.id ORDER BY v.id) INTO v_claims FROM public.income_expenses v WHERE v.organization_id=p_org AND v.contract_id=p_id AND v.commission_kind='broker' AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED';
  v_months:=greatest(0,(extract(year FROM age(v_contract.end_date,v_contract.start_date))*12+extract(month FROM age(v_contract.end_date,v_contract.start_date)))::integer);
  v_rate:=app_private.commission_rate_for_v1(p_org,v_bld,v_months,public.org_today_v1(p_org));
 ELSIF p_kind IN ('sale_contract','sale_deposit') THEN
  v_cap:=app_private.sale_bonus_cap_for_v1(p_org,v_bld,public.org_today_v1(p_org));
  SELECT array_agg(DISTINCT candidate.id ORDER BY candidate.id) INTO v_claims FROM (
    SELECT v.id FROM public.income_expenses v WHERE v.organization_id=p_org AND v.contract_id=v_contract_id AND v.commission_kind='sale' AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED' AND (p_kind='sale_contract' OR NOT coalesce(v.commission_legacy_dup,false))
    UNION ALL
    SELECT bon.id FROM app_private.sale_bonus_claims claim JOIN public.income_expenses dep ON dep.id=claim.deposit_voucher_id AND dep.organization_id=claim.organization_id JOIN public.income_expenses bon ON bon.id=claim.bonus_voucher_id AND bon.organization_id=claim.organization_id
    WHERE claim.organization_id=p_org AND (claim.deposit_voucher_id=p_id OR dep.contract_id=v_contract_id) AND bon.deleted_at IS NULL AND bon.approval_status<>'CANCELLED'
  ) candidate;
 ELSE
  v_preview:=public.preview_termination_refund_v1(p_id)-'basis';
  SELECT array_agg(DISTINCT v.id ORDER BY v.id) INTO v_claims FROM public.termination_refund_obligations o JOIN public.income_expenses v ON v.id=o.voucher_id AND v.organization_id=o.organization_id WHERE o.organization_id=p_org AND o.termination_id=p_id AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED';
  SELECT jsonb_build_object('id',o.id,'organization_id',o.organization_id,'termination_id',o.termination_id,'contract_id',o.contract_id,'version',o.version,'requested_amount',o.requested_amount,'real_held',o.real_held,'recognized_only',o.recognized_only,'basis_fingerprint',o.basis_fingerprint,'obligation_status',o.obligation_status) INTO v_obligation FROM public.termination_refund_obligations o WHERE o.organization_id=p_org AND o.termination_id=p_id ORDER BY o.version DESC,o.id LIMIT 1;
 END IF;
 RETURN jsonb_build_object('canCreate',coalesce(v_allowed,false),'canForce',public.is_super_admin() OR app_private.is_org_owner_v1(p_org,auth.uid()),'claimIds',coalesce(to_jsonb(v_claims),'[]'::jsonb),'isDeposit',CASE WHEN p_kind='sale_deposit' THEN EXISTS(SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id WHERE i.income_expense_id=p_id AND i.organization_id=p_org AND t.is_deposit) ELSE NULL END,
  'capAmount',v_cap,'months',v_months,'ratePercent',v_rate,'expectedAmount',CASE WHEN v_rate IS NOT NULL THEN round(v_contract.rent_price*v_rate/100) ELSE NULL END,'refund',v_preview,'latestObligation',v_obligation);
END $facts$;
ALTER FUNCTION app_private.contract_settlement_create_facts_v1(uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.contract_settlement_create_facts_v1(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.contract_settlement_create_facts_v1(uuid,text,uuid) TO ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION public.read_contract_settlement_create_source_v1(p_organization_id uuid,p_kind text,p_source_id uuid,p_proposed_amount numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET row_security=on
AS $reader$
DECLARE v_scope jsonb; v_contract public.contracts%ROWTYPE; v_term public.contract_terminations%ROWTYPE; v_dep public.income_expenses%ROWTYPE; v_room public.rooms%ROWTYPE;
 v_facts jsonb; v_result jsonb; v_claim_count integer; v_existing uuid; v_hidden boolean:=false; v_allowed boolean; v_reason text;
 v_name text;v_code text;v_status text;v_day date;v_contract_id uuid;v_recipient text;v_bank text;v_account text;v_building_id uuid;
BEGIN
 IF p_kind NOT IN ('broker','sale_contract','sale_deposit','termination_refund') OR p_source_id IS NULL OR (p_proposed_amount IS NOT NULL AND (p_proposed_amount='NaN'::numeric OR p_proposed_amount<0 OR p_proposed_amount<>trunc(p_proposed_amount))) THEN RAISE EXCEPTION 'Invalid source request' USING ERRCODE='22023'; END IF;
 v_scope:=app_private.income_expense_action_scope_v1(p_organization_id);
 -- Actual source and related customer/room SELECTs run under authenticated RLS.
 IF p_kind IN ('broker','sale_contract') THEN
  SELECT * INTO v_contract FROM public.contracts WHERE id=p_source_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
  v_contract_id:=v_contract.id;v_code:=v_contract.contract_number;v_status:=v_contract.status::text;v_day:=v_contract.signed_date;v_name:=coalesce(v_code,'Hợp đồng');
  SELECT * INTO v_room FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
 ELSIF p_kind='sale_deposit' THEN
  SELECT * INTO v_dep FROM public.income_expenses WHERE id=p_source_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
  v_contract_id:=v_dep.contract_id;v_code:=v_dep.code;v_status:=v_dep.approval_status;v_day:=v_dep.voucher_date;v_name:=v_dep.name;
  SELECT * INTO v_room FROM public.rooms WHERE id=v_dep.room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
 ELSE
  SELECT * INTO v_term FROM public.contract_terminations WHERE id=p_source_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_contract FROM public.contracts WHERE id=v_term.contract_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
  v_contract_id:=v_contract.id;v_code:=v_contract.contract_number;v_status:=v_term.status;v_day:=v_term.termination_date;v_name:='Hoàn tiền cọc — '||coalesce(v_code,'Hợp đồng');
  SELECT * INTO v_room FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  SELECT customer.full_name,customer.bank_name,customer.bank_account_number INTO v_recipient,v_bank,v_account FROM public.contract_customers cc JOIN public.customers customer ON customer.id=cc.customer_id AND customer.organization_id=p_organization_id WHERE cc.contract_id=v_contract_id ORDER BY cc.is_representative DESC NULLS LAST,cc.id LIMIT 1;
 END IF;
 v_building_id:=CASE WHEN p_kind='sale_deposit' THEN v_dep.building_id ELSE v_room.building_id END;
 IF (p_kind='sale_deposit' AND v_dep.room_id IS NOT NULL AND (v_room.id IS NULL OR v_room.building_id IS DISTINCT FROM v_dep.building_id)) OR (p_kind<>'sale_deposit' AND v_room.id IS NULL) OR NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=v_building_id AND organization_id=p_organization_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Source room unavailable' USING ERRCODE='42501'; END IF;
 v_facts:=app_private.contract_settlement_create_facts_v1(p_organization_id,p_kind,p_source_id);
 v_allowed:=(v_facts->>'canCreate')::boolean;
 IF NOT v_allowed THEN v_reason:='Bạn chưa có quyền lập phiếu từ nguồn này.'; END IF;
 v_claim_count:=jsonb_array_length(v_facts->'claimIds');
 IF v_claim_count=1 THEN
  SELECT id INTO v_existing FROM public.income_expenses WHERE id=(v_facts->'claimIds'->>0)::uuid AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF v_existing IS NULL THEN v_hidden:=true;v_allowed:=false;v_reason:='Nguồn đã có phiếu nhưng bạn chưa được xem phiếu đó.'; END IF;
 ELSIF v_claim_count>1 THEN v_hidden:=true;v_allowed:=false;v_reason:='Nguồn có liên kết phiếu cần đối chiếu; chưa thể lập thêm phiếu.'; END IF;
 IF p_kind='sale_deposit' AND (v_dep.type<>'INCOME' OR v_dep.approval_status='CANCELLED' OR NOT coalesce((v_facts->>'isDeposit')::boolean,false)) THEN v_allowed:=false;v_reason:='Nguồn chưa phải phiếu thu cọc còn hiệu lực.'; END IF;
 IF p_kind='termination_refund' AND (v_status NOT IN ('APPROVED','COMPLETED') OR (v_facts->'refund'->>'requestedAmount')::numeric<=0) THEN v_allowed:=false;v_reason:='Hồ sơ chưa có khoản hoàn đã được duyệt.'; END IF;
 IF p_kind IN ('sale_contract','sale_deposit') AND p_proposed_amount>(v_facts->>'capAmount')::numeric THEN v_allowed:=false;v_reason:='Số tiền đề xuất vượt trần thưởng đã công bố.'; END IF;
 v_result:=jsonb_build_object('actorId',auth.uid(),'organizationId',p_organization_id,'kind',p_kind,'sourceId',p_source_id,'canCreate',v_allowed,'blockedReason',v_reason,'canForce',(v_facts->>'canForce')::boolean,'existingVoucherId',v_existing,'hiddenExisting',v_hidden,
  'contractId',v_contract_id,'buildingId',v_building_id,'roomId',v_room.id,'sourceCode',v_code,'sourceStatus',v_status,'sourceDate',v_day,'today',public.org_today_v1(p_organization_id),'name',v_name,
  'recipientName',v_recipient,'recipientBank',v_bank,'recipientAccount',v_account,'suggestedAmount',CASE WHEN p_kind='termination_refund' THEN v_facts->'refund'->'requestedAmount' WHEN p_kind='broker' THEN v_facts->'expectedAmount' ELSE 'null'::jsonb END,'capAmount',v_facts->'capAmount',
  'basis',jsonb_build_object('kind',CASE WHEN p_kind='broker' THEN 'commission' WHEN p_kind='termination_refund' THEN 'refund' ELSE 'bonus' END,'months',v_facts->'months','ratePercent',v_facts->'ratePercent','expectedAmount',v_facts->'expectedAmount','warning',CASE WHEN p_kind='broker' AND v_facts->>'ratePercent' IS NULL THEN 'Chưa có bậc hoa hồng công bố phù hợp. Có thể đề xuất số tiền để duyệt sau.' WHEN p_kind IN ('sale_contract','sale_deposit') THEN 'Trần thưởng là giới hạn; số tiền đề xuất do bạn nhập.' ELSE NULL END),
  'refund',v_facts->'refund','latestObligation',v_facts->'latestObligation');
 -- Revision excludes proposal-dependent messages but includes the frozen source/basis/claims.
 RETURN v_result||jsonb_build_object('revision',md5((v_result-'canCreate'-'blockedReason')::text||coalesce(v_contract.updated_at::text,'')||coalesce(v_dep.updated_at::text,'')));
END $reader$;
-- Same transactional ownership handoff as T4A: the non-superuser deployer must
-- give the destination owner CREATE briefly; no committed CREATE grant remains.
GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
