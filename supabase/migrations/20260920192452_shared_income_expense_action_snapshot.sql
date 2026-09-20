-- Shared action reads. No voucher/account writes, lifecycle transition, or birth adoption.
-- A non-bypass function owner inherits the existing authenticated RLS policies. The
-- private metadata grants belong only to this NOLOGIN role, never to API callers.
BEGIN;
DO $definitions$
BEGIN
  IF to_regprocedure('public.read_income_expense_action_snapshots_v1(uuid,uuid[])') IS NOT NULL
    AND md5(pg_get_functiondef(to_regprocedure('public.read_income_expense_action_snapshots_v1(uuid,uuid[])'))) <> '6e1e6dbcad5f54f4a5690640d70094ca' THEN
    RAISE EXCEPTION 'read_income_expense_action_snapshots_v1 definition drift';
  END IF;
  IF to_regprocedure('app_private.income_expense_action_scope_v1(uuid)') IS NOT NULL
    AND md5(pg_get_functiondef(to_regprocedure('app_private.income_expense_action_scope_v1(uuid)'))) <> '38d6b30b15990db2c3ab043eb2161865' THEN
    RAISE EXCEPTION 'income_expense_action_scope_v1 definition drift';
  END IF;
END
$definitions$;
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader') THEN
    CREATE ROLE ie_action_snapshot_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolinherit)) THEN
    RAISE EXCEPTION 'ie_action_snapshot_reader role attribute drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid='ie_action_snapshot_reader'::regrole
      AND m.member <> 'postgres'::regrole)
    OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member='ie_action_snapshot_reader'::regrole
      AND (m.roleid <> 'authenticated'::regrole OR m.admin_option)) THEN
    RAISE EXCEPTION 'ie_action_snapshot_reader membership drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee='ie_action_snapshot_reader'::regrole)
    OR EXISTS (SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(col.attacl) a
      WHERE a.grantee='ie_action_snapshot_reader'::regrole AND (a.privilege_type<>'SELECT' OR a.is_grantable OR NOT (
        n.nspname='app_private' AND ((c.relname='income_expense_flow_ownership' AND col.attname=ANY(ARRAY['income_expense_id','organization_id','flow_kind']))
        OR (c.relname='canonical_write_operations' AND col.attname=ANY(ARRAY['organization_id','operation','subject_id','completed_at','payload_hash']))))))
    OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE a.grantee='ie_action_snapshot_reader'::regrole AND (a.is_grantable OR p.oid NOT IN (
        COALESCE(to_regprocedure('app_private.income_expense_action_scope_v1(uuid)'),0),
        COALESCE(to_regprocedure('public.read_income_expense_action_snapshots_v1(uuid,uuid[])'),0))))
    OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE')
    OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN
    RAISE EXCEPTION 'ie_action_snapshot_reader privilege drift';
  END IF;
END
$role$;
GRANT authenticated TO ie_action_snapshot_reader;
-- Supabase postgres is not a superuser; explicit SET membership permits ALTER OWNER.
GRANT ie_action_snapshot_reader TO postgres WITH INHERIT TRUE, SET TRUE;
GRANT USAGE ON SCHEMA public, auth, app_private TO ie_action_snapshot_reader;
GRANT SELECT (income_expense_id,organization_id,flow_kind) ON app_private.income_expense_flow_ownership TO ie_action_snapshot_reader;
GRANT SELECT (organization_id,operation,subject_id,completed_at,payload_hash)
  ON app_private.canonical_write_operations TO ie_action_snapshot_reader;
CREATE OR REPLACE FUNCTION app_private.income_expense_action_scope_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $scope$
DECLARE v_actor uuid := auth.uid(); v_authorization bigint; v_permissions jsonb;
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization required' USING ERRCODE='42501';
  END IF;
  SELECT o.authorization_version INTO v_authorization FROM public.organizations o
  WHERE o.id=p_organization_id AND o.status='ACTIVE' AND EXISTS (
    SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=o.id AND m.user_id=v_actor
    AND m.status='ACTIVE' AND m.revoked_at IS NULL
    AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=now() AND (m.valid_to IS NULL OR m.valid_to>now()));
  IF v_authorization IS NULL THEN RAISE EXCEPTION 'Active organization membership required' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) INTO v_permissions
    FROM app_private.all_scoped_keys_v3(p_organization_id) p
    WHERE permission_key IN ('income_expenses.approve','income_expenses.edit','income_expenses.cancel','income_expenses.reverse');
  RETURN jsonb_build_object('actorId',v_actor,'organizationId',p_organization_id,'isAdmin',public.is_admin(),
    'authorizationVersion',v_authorization,'permissionScopes',v_permissions,'routes',jsonb_build_object(
      'readSemantics',app_private.finance_v2_route_pure_v1('income_expense.read_semantics.v2',p_organization_id),
      'workflow',app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',p_organization_id),
      'posting',app_private.finance_v2_route_pure_v1('income_expense.posting.v2',p_organization_id),
      'access',app_private.finance_v2_route_pure_v1('cashbook.access.v2',p_organization_id),
      'accountingStandardStrict',app_private.ie_accounting_strict_v1(p_organization_id)));
END
$scope$;
REVOKE ALL ON FUNCTION app_private.income_expense_action_scope_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.income_expense_action_scope_v1(uuid) TO ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION public.read_income_expense_action_snapshots_v1(p_organization_id uuid, p_voucher_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
SET row_security = on
AS $fn$
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
$fn$;
GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.read_income_expense_action_snapshots_v1(uuid,uuid[]) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.read_income_expense_action_snapshots_v1(uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_income_expense_action_snapshots_v1(uuid,uuid[]) TO authenticated;

-- Existing shared custody reader: unchanged id/name contract, exact writer access
-- assertion, deterministic order for pagination. Only authorization denials omit a
-- cashbook; unexpected database errors propagate rather than becoming empty data.
-- Baseline pg_get_functiondef MD5 d3e69a10cf4e1cb6c99698df62d0602a (local baseline + forward lane).
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.list_cashbooks_for_expense_v2()'::regprocedure)) NOT IN (
    'd3e69a10cf4e1cb6c99698df62d0602a','b8a05055824b9bcf2f3710a4f369b267') THEN
    RAISE EXCEPTION 'list_cashbooks_for_expense_v2 definition drift';
  END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION public.list_cashbooks_for_expense_v2()
RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE r record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  FOR r IN SELECT DISTINCT a.id,a.name,a.organization_id,m.id AS membership_id
    FROM public.cashbook_possession_bindings b
    JOIN public.organization_memberships m ON m.id=b.membership_id AND m.organization_id=b.organization_id
    JOIN public.accounts a ON a.id=b.cashbook_id AND a.organization_id=b.organization_id
    JOIN public.organizations o ON o.id=a.organization_id AND o.status='ACTIVE'
    WHERE m.user_id=auth.uid() AND b.possession_kind='CUSTODIAN'
    ORDER BY a.name,a.id,m.id
  LOOP
    BEGIN
      PERFORM app_private.assert_cashbook_access_v2(r.organization_id,r.id,'CUSTODIAN',r.membership_id);
    EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
    END;
    id := r.id; name := r.name; RETURN NEXT;
  END LOOP;
END
$fn$;
COMMENT ON FUNCTION public.list_cashbooks_for_expense_v2() IS 'T4A shared custody guard v1';
REVOKE ALL ON FUNCTION public.list_cashbooks_for_expense_v2() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_cashbooks_for_expense_v2() TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
