-- Review-only transitions shared by Thu chi and contract settlement.
-- Existing signatures and canonical operation/audit contracts are preserved.
-- No create, money patch, approval, posting, source mutation or maker backfill.
CREATE OR REPLACE FUNCTION app_private.authorize_income_expense_review_v1(
  p_voucher public.income_expenses, p_action text
) RETURNS TABLE(user_id uuid, membership_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_uid uuid; v_mid uuid; v_permission text;
BEGIN
  IF p_action NOT IN ('request_changes','resubmit') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Unsupported review operation' USING ERRCODE='22023';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(p_voucher.organization_id) r;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
    WHERE o.id=p_voucher.organization_id AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'Active organization required' USING ERRCODE='42501';
  END IF;
  IF p_voucher.building_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.buildings b WHERE b.id=p_voucher.building_id
      AND b.organization_id=p_voucher.organization_id AND b.deleted_at IS NULL
      AND app_private.building_org_visible_v1(b.id)
      AND (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id))
  ) THEN RAISE EXCEPTION 'Building scope denied' USING ERRCODE='42501'; END IF;
  IF (p_voucher.has_restricted_item AND p_voucher.user_id IS DISTINCT FROM v_uid AND NOT public.can_view_restricted_ie())
    OR ((public.is_admin() OR public.is_super_admin()) AND p_voucher.user_id=ANY(public.demo_user_ids())) THEN
    RAISE EXCEPTION 'Voucher access denied' USING ERRCODE='42501';
  END IF;
  -- No ownership row means an existing legacy voucher; domain owners still fail closed.
  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher.id, 'CANONICAL_INCOME_EXPENSE');
  -- Reservation's existing source guard has no review dispatcher. Do not bypass it.
  IF p_voucher.system_source IN ('reservation.refund','reservation.forfeit_revenue','reservation.forfeit_offset')
    OR EXISTS (SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=p_voucher.id)
    OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers s WHERE s.voucher_id=p_voucher.id) THEN
    RAISE EXCEPTION 'Source review dispatcher unavailable' USING ERRCODE='42501';
  END IF;
  IF p_action='resubmit' AND p_voucher.maker_user_id IS NOT NULL THEN
    IF p_voucher.maker_user_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'Only the original maker may resubmit' USING ERRCODE='42501';
    END IF;
  ELSE
    v_permission := CASE WHEN p_action='request_changes' THEN 'income_expenses.approve' ELSE 'income_expenses.edit' END;
    IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
      v_uid,p_voucher.organization_id,v_permission,p_voucher.building_id,NULL)),false) THEN
      RAISE EXCEPTION 'Review capability required in building scope' USING ERRCODE='42501';
    END IF;
  END IF;
  IF app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',p_voucher.organization_id)='FROZEN' THEN
    RAISE EXCEPTION 'Review workflow frozen' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT v_uid,v_mid;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.authorize_income_expense_review_v1(public.income_expenses,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.is_income_expense_review_operation_v1(p_org uuid,p_voucher uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_private.ie_transition_authorization t
    JOIN app_private.canonical_write_operations o
      ON o.organization_id=p_org AND o.subject_scope=p_voucher::text
     AND o.operation IN ('income_expense.request_changes.v2','income_expense.resubmit.v2')
     AND o.transaction_id=pg_current_xact_id() AND o.completed_at IS NULL
     AND o.actor_id=auth.uid()
    WHERE t.income_expense_id=p_voucher AND t.xid=pg_current_xact_id()
      AND t.purpose='FINANCE_V2_LIFECYCLE'
  )
$fn$;
REVOKE ALL ON FUNCTION app_private.is_income_expense_review_operation_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Keep the lifecycle token so bridge a85 skips cash. The extra field allowance is
-- bound to an OPEN review op in this exact transaction, organization and subject.
-- It is checked before the legacy early return, so unowned rows get the same freeze.
DO $patch$
DECLARE v_definition text; v_anchor text := E'  if tg_op = ''UPDATE'' then\n'; v_insert text;
BEGIN
  SELECT pg_get_functiondef('app_private.guard_income_expense_owned_payload()'::regprocedure) INTO v_definition;
  IF md5(v_definition)='18b3e1c11f3e698f1daf2cd082313448' THEN RETURN; END IF;
  IF md5(v_definition)<>'fb01ae8c9de7b283d19ade8195eba726' THEN
    RAISE EXCEPTION 'Review freeze patch: definition drift; re-audit before applying';
  END IF;
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Review freeze patch: expected unique UPDATE anchor missing';
  END IF;
  v_insert := $scope$    -- REVIEW_ONLY_CANONICAL_OP_V1
    if app_private.is_income_expense_review_operation_v1(old.organization_id,old.id) then
      if (to_jsonb(old) - array['review_state','review_reason','review_version','change_field_mask','updated_at'])
        is distinct from
         (to_jsonb(new) - array['review_state','review_reason','review_version','change_field_mask','updated_at'])
        or new.review_version is distinct from old.review_version + 1
        or not ((old.review_state in ('PENDING','DISPUTED') and new.review_state='CHANGES_REQUESTED')
             or (old.review_state='CHANGES_REQUESTED' and new.review_state='PENDING')) then
        raise exception 'review scope may only transition review metadata of %', old.id using errcode='55000';
      end if;
      return new;
    end if;

$scope$;
  EXECUTE replace(v_definition,v_anchor,v_anchor||v_insert);
END
$patch$;

-- a86 normally stamps missing birth provenance after the freeze trigger.
-- Review must preserve missing/existing provenance exactly, without a new birth.
-- All INSERTs and non-review updates keep the existing birth boundary behavior.
DO $patch$
DECLARE v_definition text; v_anchor text := E'BEGIN\n';
BEGIN
  SELECT pg_get_functiondef('app_private.finance_v2_birth_provenance_bridge()'::regprocedure) INTO v_definition;
  IF md5(v_definition)='502b59b43551d64bf602da4b01f7d536' THEN RETURN; END IF;
  IF md5(v_definition)<>'a8e8c8c66676f566e52edf888bc43579' THEN
    RAISE EXCEPTION 'Review birth patch: definition drift; re-audit before applying';
  END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||$scope$  -- REVIEW_PRESERVE_BIRTH_V1
  IF TG_OP='UPDATE' AND app_private.is_income_expense_review_operation_v1(OLD.organization_id,OLD.id) THEN
    RETURN NEW;
  END IF;
$scope$);
END
$patch$;

DO $provenance$
DECLARE v_definition text := pg_get_functiondef('public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)'::regprocedure);
BEGIN
  IF md5(v_definition) NOT IN ('c3769605c5ac35134935d49a32a5d1d9','a7b885abecda8b1b8a5a6545f3c76975') THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: definition drift; re-audit before applying';
  END IF;
END
$provenance$;
CREATE OR REPLACE FUNCTION public.request_income_expense_changes_v2(p_voucher uuid, p_expected_review_version bigint, p_reason text, p_field_mask jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid; v_mid uuid; v_org uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'r', p_reason, 'm', p_field_mask)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  -- SHARED_REVIEW_TRANSITION_V1
  IF p_expected_review_version IS NULL OR p_expected_review_version<0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: expected review version required' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id=p_voucher;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  -- Authorization precedes replay: a cached response cannot outlive revoked authority.
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.authorize_income_expense_review_v1(v_ie,'request_changes') r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  IF v_ie.review_version IS DISTINCT FROM p_expected_review_version THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: review_version mismatch' USING ERRCODE='40001';
  END IF;
  IF v_ie.active_posting_id_v2 IS NOT NULL OR NOT (
    (v_ie.posting_mode='CASHBOOK' AND v_ie.posting_status='UNPOSTED') OR
    (v_ie.posting_mode='NON_CASH' AND v_ie.posting_status='NOT_APPLICABLE')
  ) OR v_ie.posting_mode IS NULL OR v_ie.posting_status IS NULL THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher already posted or missing lifecycle state' USING ERRCODE='55000';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'UNAPPROVED' OR (v_ie.review_state IS NULL OR v_ie.review_state NOT IN ('PENDING','DISPUTED')) THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher not in a requestable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'CHANGES_REQUESTED', review_reason = p_reason,
         change_field_mask = p_field_mask, review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;
  -- Check the final row too: BEFORE triggers after the freeze can otherwise add metadata.
  IF EXISTS (SELECT 1 FROM public.income_expenses final WHERE final.id=p_voucher
    AND (to_jsonb(final)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'])
      IS DISTINCT FROM (to_jsonb(v_ie)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'])) THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: review changed non-review data' USING ERRCODE='55000';
  END IF;

  UPDATE public.approval_requests ar
     SET state = 'CHANGES_REQUESTED', outcome_kind = 'REQUEST_CHANGES', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'CHANGES_REQUESTED', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'REQUEST_CHANGES', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$function$
;
REVOKE ALL ON FUNCTION public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text) TO authenticated;

DO $provenance$
DECLARE v_definition text := pg_get_functiondef('public.resubmit_income_expense_v2(uuid,bigint,jsonb,text)'::regprocedure);
BEGIN
  IF md5(v_definition) NOT IN ('722dcc99bec52a059f7c45c08d085f80','d3a9226f0b75940c354e5c81497097b4') THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: definition drift; re-audit before applying';
  END IF;
END
$provenance$;
CREATE OR REPLACE FUNCTION public.resubmit_income_expense_v2(p_voucher uuid, p_expected_review_version bigint, p_patch jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid; v_mid uuid; v_org uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'p', p_patch)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  -- SHARED_REVIEW_TRANSITION_V1
  IF p_expected_review_version IS NULL OR p_expected_review_version<0 THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: expected review version required' USING ERRCODE='22023';
  END IF;
  IF p_patch IS NOT NULL AND p_patch <> '{}'::jsonb THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: patch is unsupported; supplement separately' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id=p_voucher;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  -- Authorization precedes replay: a cached response cannot outlive revoked authority.
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.authorize_income_expense_review_v1(v_ie,'resubmit') r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  IF v_ie.review_version IS DISTINCT FROM p_expected_review_version THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: review_version mismatch' USING ERRCODE='40001';
  END IF;
  IF v_ie.active_posting_id_v2 IS NOT NULL OR NOT (
    (v_ie.posting_mode='CASHBOOK' AND v_ie.posting_status='UNPOSTED') OR
    (v_ie.posting_mode='NON_CASH' AND v_ie.posting_status='NOT_APPLICABLE')
  ) OR v_ie.posting_mode IS NULL OR v_ie.posting_status IS NULL THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: voucher already posted or missing lifecycle state' USING ERRCODE='55000';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'UNAPPROVED' OR v_ie.review_state IS DISTINCT FROM 'CHANGES_REQUESTED' THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: only a CHANGES_REQUESTED voucher can be resubmitted (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  -- Guard: no PENDING request may remain open before a fresh submission.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.organization_id = v_ie.organization_id
               AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
               AND ar.state = 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: an open approval request already exists' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'PENDING', review_reason = NULL, change_field_mask = NULL,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;
  -- Check the final row too: BEFORE triggers after the freeze can otherwise add metadata.
  IF EXISTS (SELECT 1 FROM public.income_expenses final WHERE final.id=p_voucher
    AND (to_jsonb(final)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'])
      IS DISTINCT FROM (to_jsonb(v_ie)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'])) THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: review changed non-review data' USING ERRCODE='55000';
  END IF;

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'PENDING', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'RESUBMITTED', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$function$
;
REVOKE ALL ON FUNCTION public.resubmit_income_expense_v2(uuid,bigint,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resubmit_income_expense_v2(uuid,bigint,jsonb,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
