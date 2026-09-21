-- Shared recipient-only entry to the existing Thu chi writer. No new ownership exception.
BEGIN;
DO $dependencies$
BEGIN
  IF to_regprocedure('public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)') IS NOT NULL THEN
    IF md5(pg_get_functiondef(to_regprocedure('public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)'))) <> '19d5834bed3c4fdbba5c14967a796ffe'
      OR (SELECT proowner FROM pg_proc WHERE oid='public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)'::regprocedure) <> 'postgres'::regrole
      OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid='public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)'::regprocedure
        AND (a.grantee NOT IN ('postgres'::regrole,'authenticated'::regrole) OR a.privilege_type<>'EXECUTE' OR (a.grantee='authenticated'::regrole AND a.is_grantable)))
      OR NOT has_function_privilege('authenticated','public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)','EXECUTE') THEN
      RAISE EXCEPTION 'Recipient writer definition or ACL drift';
    END IF;
  END IF;
  IF to_regprocedure('public.read_income_expense_action_snapshots_v1(uuid,uuid[])') IS NULL
    OR md5(pg_get_functiondef('public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)'::regprocedure)) <> 'c6ed1d47823837349c92e8769932053a'
    OR md5(pg_get_functiondef('app_private.assert_manual_voucher_v1(uuid,text)'::regprocedure)) <> '99d6511dcfbecc5e1aceafb95693a70b' THEN
    RAISE EXCEPTION 'Recipient writer dependency drift';
  END IF;
  IF md5(pg_get_functiondef('public.read_income_expense_action_snapshots_v1(uuid,uuid[])'::regprocedure)) NOT IN ('6e1e6dbcad5f54f4a5690640d70094ca','a9f0074e0fe76add7b52aec790fe56cf') THEN
    RAISE EXCEPTION 'Recipient visibility definition drift';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid='public.read_income_expense_action_snapshots_v1(uuid,uuid[])'::regprocedure) <> 'ie_action_snapshot_reader'::regrole
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR NOT rolinherit)) THEN
    RAISE EXCEPTION 'Recipient visibility reader role drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='ie_action_snapshot_reader'::regrole AND member<>'postgres'::regrole)
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='ie_action_snapshot_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option)) THEN
    RAISE EXCEPTION 'Recipient visibility reader membership drift';
  END IF;
END
$dependencies$;
CREATE OR REPLACE FUNCTION public.update_income_expense_recipient_v1(
  p_organization_id uuid, p_voucher_id uuid, p_expected jsonb, p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $recipient$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_after public.income_expenses%ROWTYPE;
  v_batch jsonb; v_visible jsonb; v_expected jsonb; v_patch jsonb := '{}'::jsonb;
  k text; v_allowed boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_voucher_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated voucher scope required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch='{}'::jsonb
    OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Recipient patch and expected state required' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('payerName','bankName','bankAccount') OR jsonb_typeof(p_patch->k) NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Recipient-only patch required' USING ERRCODE='22023';
    END IF;
    v_patch := v_patch || jsonb_build_object(CASE k WHEN 'payerName' THEN 'payer_name' WHEN 'bankName' THEN 'receive_bank_name' ELSE 'receive_bank_account' END,p_patch->k);
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(p_expected))<>6
    OR NOT p_expected ?& ARRAY['payerName','bankName','bankAccount','approvalVersion','postingVersion','reviewVersion'] THEN
    RAISE EXCEPTION 'Exact expected recipient and versions required' USING ERRCODE='22023';
  END IF;
  -- This existing reader runs under a non-bypass owner and actual authenticated RLS.
  -- Its scope check rejects inactive membership; no hidden voucher is disclosed by a privileged pre-read.
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  v_batch := public.read_income_expense_action_snapshots_v1(p_organization_id,ARRAY[p_voucher_id]);
  SELECT value INTO v_visible FROM jsonb_array_elements(v_batch->'rows') WHERE value->>'id'=p_voucher_id::text;
  IF v_visible IS NULL OR (v_visible->'permissions'->>'edit')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Voucher unavailable or recipient edit denied' USING ERRCODE='42501';
  END IF;
  IF v_batch->'routes'->>'workflow'='FROZEN' OR v_batch->'routes'->>'posting'='FROZEN' THEN
    RAISE EXCEPTION 'Voucher workflow frozen' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Voucher unavailable' USING ERRCODE='42501'; END IF;
  -- Recheck current building authority after taking the row lock; the earlier RLS snapshot is not a write grant.
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'income_expenses.edit',v.building_id,NULL);
  IF v_allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'Recipient edit denied' USING ERRCODE='42501'; END IF;
  IF v.approval_status IS DISTINCT FROM 'UNAPPROVED' OR v.active_posting_id_v2 IS NOT NULL
    OR NOT (COALESCE(v.posting_mode='CASHBOOK' AND v.posting_status='UNPOSTED',false)
      OR COALESCE(v.posting_mode='NON_CASH' AND v.posting_status='NOT_APPLICABLE',false)) THEN
    RAISE EXCEPTION 'Voucher is not editable pending content' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership WHERE income_expense_id=v.id) THEN
    RAISE EXCEPTION 'Source-owned voucher payload is frozen' USING ERRCODE='55000';
  END IF;
  PERFORM app_private.assert_manual_voucher_v1(v.id,'sửa người nhận');
  v_expected := jsonb_build_object('payerName',v.payer_name,'bankName',v.receive_bank_name,'bankAccount',v.receive_bank_account,
    'approvalVersion',v.approval_version,'postingVersion',v.posting_version,'reviewVersion',v.review_version);
  IF v_expected IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Voucher recipient or version changed' USING ERRCODE='40001';
  END IF;
  -- Keep period/ownership/restricted-item guards and audit in the existing writer.
  -- No items argument, money field, bank field not changed by the user, or lifecycle token is forwarded.
  PERFORM public.ie_compat_update_pending_v2(v.id,v_patch);
  SELECT * INTO STRICT v_after FROM public.income_expenses WHERE id=v.id;
  -- Existing a86 may register legacy provenance on any legitimate pending update.
  -- Preserve that shared behavior only with its actual completed operation; never replace prior provenance.
  IF v.birth_operation_id IS NOT NULL AND
    ROW(v.birth_operation_id,v.birth_txid,v.source_payload_hash) IS DISTINCT FROM ROW(v_after.birth_operation_id,v_after.birth_txid,v_after.source_payload_hash)
    OR v.birth_operation_id IS NULL AND (v_after.birth_operation_id IS DISTINCT FROM v.id OR v_after.birth_txid IS NULL OR NOT EXISTS (
      SELECT 1 FROM app_private.canonical_write_operations op WHERE op.organization_id=v.organization_id
        AND op.operation='income_expense.create.v2' AND op.subject_id=v.id AND op.payload_hash=v_after.source_payload_hash AND op.completed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Unexpected recipient edit provenance' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(v)-ARRAY['payer_name','receive_bank_name','receive_bank_account','updated_at','birth_operation_id','birth_txid','source_payload_hash'])
    IS DISTINCT FROM (to_jsonb(v_after)-ARRAY['payer_name','receive_bank_name','receive_bank_account','updated_at','birth_operation_id','birth_txid','source_payload_hash']) THEN
    RAISE EXCEPTION 'Recipient edit changed unrelated voucher content' USING ERRCODE='55000',
      DETAIL=(SELECT string_agg(key,',') FROM jsonb_each(to_jsonb(v)) WHERE value IS DISTINCT FROM to_jsonb(v_after)->key);
  END IF;
  IF jsonb_build_object('payerName',v_after.payer_name,'bankName',v_after.receive_bank_name,'bankAccount',v_after.receive_bank_account)
    IS DISTINCT FROM ((v_expected-ARRAY['approvalVersion','postingVersion','reviewVersion'])||p_patch) THEN
    RAISE EXCEPTION 'Recipient edit changed untouched recipient fields' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('voucherId',v.id,'organizationId',v.organization_id,'recipient',jsonb_build_object(
    'payerName',v_after.payer_name,'bankName',v_after.receive_bank_name,'bankAccount',v_after.receive_bank_account));
END
$recipient$;
ALTER FUNCTION public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb) TO authenticated;
COMMIT;
