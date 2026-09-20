-- T4B: enrich only vouchers already visible under the T4A authenticated RLS owner.
-- No writer changes, birth adoption, private table grant, or business-data writes.
BEGIN;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.read_income_expense_action_snapshots_v1(uuid,uuid[])'::regprocedure)) NOT IN ('6e1e6dbcad5f54f4a5690640d70094ca','a9f0074e0fe76add7b52aec790fe56cf') THEN RAISE EXCEPTION 'Snapshot definition drift'; END IF;
 IF to_regprocedure('app_private.income_expense_action_capabilities_v1(uuid,uuid)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('app_private.income_expense_action_capabilities_v1(uuid,uuid)'))) <> 'f46a0e9c31bf3dde66348dd048ad1d7f' THEN RAISE EXCEPTION 'Capability definition drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Reader role drift'; END IF;
 IF (SELECT proowner FROM pg_proc WHERE oid='public.read_income_expense_action_snapshots_v1(uuid,uuid[])'::regprocedure) <> 'ie_action_snapshot_reader'::regrole THEN RAISE EXCEPTION 'Snapshot owner drift'; END IF;
 IF has_function_privilege('anon','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') OR has_function_privilege('service_role','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') OR NOT has_function_privilege('authenticated','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') OR pg_has_role('authenticated','ie_action_snapshot_reader','SET') THEN RAISE EXCEPTION 'Snapshot ACL drift'; END IF;
 IF to_regprocedure('app_private.income_expense_action_capabilities_v1(uuid,uuid)') IS NOT NULL THEN
   IF (SELECT proowner FROM pg_proc WHERE oid='app_private.income_expense_action_capabilities_v1(uuid,uuid)'::regprocedure) <> 'postgres'::regrole THEN RAISE EXCEPTION 'Capability owner drift'; END IF;
   IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='app_private.income_expense_action_capabilities_v1(uuid,uuid)'::regprocedure AND (a.grantee NOT IN ('postgres'::regrole,'ie_action_snapshot_reader'::regrole) OR a.privilege_type<>'EXECUTE' OR (a.grantee='ie_action_snapshot_reader'::regrole AND a.is_grantable))) OR NOT has_function_privilege('ie_action_snapshot_reader','app_private.income_expense_action_capabilities_v1(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Capability ACL drift'; END IF;
 END IF;
 IF md5(pg_get_functiondef('app_private.assert_manual_voucher_v1(uuid,text)'::regprocedure)) <> '99d6511dcfbecc5e1aceafb95693a70b' THEN RAISE EXCEPTION 'Writer guard definition drift: app_private.assert_manual_voucher_v1(uuid,text)'; END IF;
 IF md5(pg_get_functiondef('app_private.guard_income_expense_owned_payload()'::regprocedure)) <> '18b3e1c11f3e698f1daf2cd082313448' THEN RAISE EXCEPTION 'Writer guard definition drift: app_private.guard_income_expense_owned_payload()'; END IF;
 IF md5(pg_get_functiondef('public.cancel_income_expense_v1(uuid,text)'::regprocedure)) <> '513496ee91f0af57b30e0841d4691848' THEN RAISE EXCEPTION 'Writer guard definition drift: public.cancel_income_expense_v1(uuid,text)'; END IF;
 IF md5(pg_get_functiondef('public.ie_compat_cancel_v2(uuid[],text)'::regprocedure)) <> '17e799ecf4bb9771f5af019d04999aa7' THEN RAISE EXCEPTION 'Writer guard definition drift: public.ie_compat_cancel_v2(uuid[],text)'; END IF;
 IF md5(pg_get_functiondef('public.set_termination_forfeit_status_v1(uuid,text)'::regprocedure)) <> '397c66bd34c3518401e6aef9b2940df5' THEN RAISE EXCEPTION 'Writer guard definition drift: public.set_termination_forfeit_status_v1(uuid,text)'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION app_private.income_expense_action_capabilities_v1(p_voucher uuid,p_organization uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog,public,app_private
AS $cap$
DECLARE v public.income_expenses%ROWTYPE; f text; pair app_private.termination_forfeit_authorizations%ROWTYPE;
  v_manual boolean := true; v_engine boolean; v_forfeit_allowed boolean := false; v_edit boolean; v_restricted boolean;
BEGIN
  -- Only the non-bypass snapshot owner can call this helper, after materializing
  -- the voucher through authenticated RLS. Clients have no EXECUTE privilege.
  PERFORM app_private.income_expense_action_scope_v1(p_organization);
  SELECT * INTO STRICT v FROM public.income_expenses WHERE id=p_voucher AND organization_id=p_organization AND deleted_at IS NULL;
  SELECT flow_kind INTO f FROM app_private.income_expense_flow_ownership WHERE income_expense_id=v.id AND organization_id=v.organization_id;
  SELECT * INTO pair FROM app_private.termination_forfeit_authorizations
    WHERE organization_id=v.organization_id AND (revenue_voucher_id=v.id OR offset_voucher_id=v.id);
  IF FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id
      CROSS JOIN LATERAL app_private.authorized_scope_v3('income_expenses.approve',v.organization_id) p
      WHERE c.id=pair.contract_id AND c.organization_id=v.organization_id
        AND (p.org_wide OR r.building_id=ANY(p.building_ids))) INTO v_forfeit_allowed;
    -- Existing pair writer permits super admin; this flag only mirrors its authority.
    v_forfeit_allowed := v_forfeit_allowed OR public.is_super_admin();
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.subject_type='FINANCIAL_VOUCHER'
    AND a.subject_id=ANY(ARRAY[v.id,pair.revenue_voucher_id,pair.offset_voucher_id])
    AND a.state IN ('PENDING_APPROVAL','POSTED')) INTO v_engine;
  BEGIN PERFORM app_private.assert_manual_voucher_v1(v.id,'sửa');
  EXCEPTION WHEN insufficient_privilege THEN v_manual := false; END;
  v_restricted := NOT COALESCE(v.has_restricted_item,false) OR v.user_id=auth.uid()
    OR public.can_view_restricted_ie() OR public.is_super_admin();
  -- Exact legacy cancel_income_expense_v1 edit guard; no new authority is granted.
  v_edit := v_restricted AND (public.is_super_admin() OR public.is_admin()
    OR public.has_perm_full_scope('income_expenses','edit')
    OR v.building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
    OR (v.user_id=auth.uid() AND v.building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))));
  RETURN jsonb_build_object('forfeitPair',pair.revenue_voucher_id IS NOT NULL,'forfeitAllowed',v_forfeit_allowed,
    'engineBlocked',v_engine,'manual',v_manual,'legacyCancelAllowed',COALESCE(v_edit,false),
    'compatCancelOwner',COALESCE(v_restricted AND (v.user_id=auth.uid() OR public.is_super_admin()
      OR app_private.is_org_owner_v1(v.organization_id,auth.uid())),false),
    'birthPrior',v.birth_txid IS NOT NULL AND v.birth_txid IS DISTINCT FROM pg_current_xact_id_if_assigned(),
    'requiresRealAccount',v.shareholder_id IS NOT NULL,
    'reservationMoneyBlocked',COALESCE(v.system_source LIKE 'reservation.%',false)
      OR EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.organization_id=v.organization_id AND s.source_voucher_id=v.id)
      OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers leg WHERE leg.organization_id=v.organization_id AND leg.voucher_id=v.id),
    'reservationRefundReverseAllowed',COALESCE(v.system_source='reservation.refund',false)
      AND EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers leg WHERE leg.organization_id=v.organization_id AND leg.voucher_id=v.id));
END
$cap$;
ALTER FUNCTION app_private.income_expense_action_capabilities_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.income_expense_action_capabilities_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.income_expense_action_capabilities_v1(uuid,uuid) TO ie_action_snapshot_reader;
CREATE OR REPLACE FUNCTION public.read_income_expense_action_snapshots_v1(p_organization_id uuid, p_voucher_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
 SET row_security TO 'on'
AS $function$
DECLARE v_scope jsonb; v_rows jsonb;
BEGIN
  IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids)>200 OR array_position(p_voucher_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'At most 200 non-null voucher IDs required' USING ERRCODE='22023';
  END IF;
  v_scope := app_private.income_expense_action_scope_v1(p_organization_id);
  IF EXISTS (SELECT 1 FROM public.income_expenses v JOIN app_private.income_expense_flow_ownership f ON f.income_expense_id=v.id
    WHERE v.id=ANY(p_voucher_ids) AND v.organization_id=p_organization_id AND f.organization_id IS DISTINCT FROM v.organization_id) THEN
    RAISE EXCEPTION 'Voucher ownership scope mismatch' USING ERRCODE='22000';
  END IF;

  -- This query runs under the non-bypass owner: public.income_expenses enforces
  -- its real authenticated policies (including salary, profit, fund and sandbox).
  WITH permissions AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(v_scope->'permissionScopes')
      AS p(permission_key text,org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
  ), visible AS MATERIALIZED (
    SELECT v.* FROM public.income_expenses v
    WHERE v.id=ANY(p_voucher_ids) AND v.organization_id=p_organization_id AND v.deleted_at IS NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',v.id,'organizationId',v.organization_id,'buildingId',v.building_id,'roomId',v.room_id,
    'contractId',v.contract_id,'tenantId',v.tenant_id,'code',v.code,'name',v.name,'type',v.type,
    'totalAmount',v.total_amount::text,'userId',v.user_id,'makerUserId',v.maker_user_id,
    'payerName',v.payer_name,'receiveBankName',v.receive_bank_name,'receiveBankAccount',v.receive_bank_account,
    'notes',v.notes,'attachments',COALESCE(v.attachments,'[]'::jsonb),'voucherDate',v.voucher_date,
    'accountId',v.account_id,'activePostingId',v.active_posting_id_v2,'approvalStatus',v.approval_status,
    'postingStatus',v.posting_status,'postingMode',v.posting_mode,'reviewState',v.review_state,'reviewReason',v.review_reason,
    'approvalVersion',v.approval_version,'postingVersion',v.posting_version,'reviewVersion',v.review_version,
    'systemSource',v.system_source,'flowKind',f.flow_kind,
    'capabilities',app_private.income_expense_action_capabilities_v1(v.id,v.organization_id),
    'birthState',CASE
      WHEN v.birth_operation_id IS NULL OR v.birth_txid IS NULL OR v.source_payload_hash IS NULL THEN 'MISSING'
      WHEN f.flow_kind IS NOT NULL AND f.flow_kind<>'CANONICAL_INCOME_EXPENSE' THEN 'UNVERIFIED'
      WHEN EXISTS (SELECT 1 FROM app_private.canonical_write_operations op
        WHERE op.organization_id=v.organization_id AND op.operation='income_expense.create.v2'
        AND op.subject_id=v.id AND op.completed_at IS NOT NULL AND op.payload_hash=v.source_payload_hash
        AND v.birth_txid IS DISTINCT FROM pg_current_xact_id_if_assigned()) THEN 'COMMITTED'
      ELSE 'INVALID' END,
    'permissions',jsonb_build_object(
      'approve',EXISTS(SELECT 1 FROM permissions p WHERE p.permission_key='income_expenses.approve' AND (p.org_wide OR v.building_id=ANY(p.building_ids))),
      'edit',EXISTS(SELECT 1 FROM permissions p WHERE p.permission_key='income_expenses.edit' AND (p.org_wide OR v.building_id=ANY(p.building_ids))),
      'cancel',EXISTS(SELECT 1 FROM permissions p WHERE p.permission_key='income_expenses.cancel' AND (p.org_wide OR v.building_id=ANY(p.building_ids))),
      'reverse',EXISTS(SELECT 1 FROM permissions p WHERE p.permission_key='income_expenses.reverse' AND (p.org_wide OR v.building_id=ANY(p.building_ids)))
    )) ORDER BY v.id),'[]'::jsonb) INTO v_rows
  FROM visible v LEFT JOIN app_private.income_expense_flow_ownership f ON f.income_expense_id=v.id;

  RETURN (v_scope-'permissionScopes') || jsonb_build_object('rows',v_rows);
END
$function$;

NOTIFY pgrst,'reload schema';
COMMIT;
