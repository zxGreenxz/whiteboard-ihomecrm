-- Read-only, non-enumerating proof for exactly one caller-owned DEMO G3
-- fixture. It creates no authority to write, cancel, approve, or list vouchers.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(
  p_organization_id uuid,
  p_attempt_id uuid,
  p_case_id int,
  p_client_request_id text,
  p_plan_id uuid,
  p_voucher_id uuid,
  p_digest_schema_version int,
  p_expected_ownership_digest text,
  p_expected_state_digest text,
  p_expected_approval_version bigint,
  p_expected_posting_version bigint,
  p_phase text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $proof$
DECLARE
  v_actor uuid := auth.uid();
  v_plan app_private.copilot_plans%ROWTYPE;
  v_step app_private.copilot_plan_steps%ROWTYPE;
  v_step_two app_private.copilot_plan_steps%ROWTYPE;
  v_ledger app_private.copilot_action_ledger%ROWTYPE;
  v_audit public.ai_write_audit%ROWTYPE;
  v_voucher public.income_expenses%ROWTYPE;
  v_item public.income_expense_items%ROWTYPE;
  v_item_count bigint;
  v_ledger_count bigint;
  v_request_count bigint;
  v_expected_request text;
  v_ownership_material text;
  v_ownership_digest text;
  v_state_material text;
  v_state_digest text;
  v_checked_at timestamptz := statement_timestamp();
BEGIN
  IF v_actor IS NULL
     OR p_organization_id IS DISTINCT FROM 'dddd0000-0000-4000-8000-000000000001'::uuid
     OR p_attempt_id IS NULL
     OR p_case_id NOT IN (3, 8)
     OR p_client_request_id IS NULL
     OR p_plan_id IS NULL
     OR p_voucher_id IS NULL
     OR p_digest_schema_version IS DISTINCT FROM 1
     OR p_expected_ownership_digest !~ '^[a-f0-9]{64}$'
     OR p_expected_state_digest !~ '^[a-f0-9]{64}$'
     OR p_expected_approval_version IS NULL OR p_expected_approval_version < 1
     OR p_expected_posting_version IS NULL OR p_expected_posting_version < 1
     OR p_phase NOT IN ('before_cancel', 'cancelled') THEN
    RAISE EXCEPTION 'owned_fixture_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_expected_request := 'g3:' || p_case_id::text || ':' || p_attempt_id::text;
  IF p_client_request_id IS DISTINCT FROM v_expected_request
     OR NOT EXISTS (
       SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = v_actor
          AND m.organization_id = p_organization_id
          AND m.status = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'owned_fixture_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT p.* INTO v_plan
    FROM app_private.copilot_plans p
   WHERE p.id = p_plan_id
     AND p.organization_id = p_organization_id
     AND p.user_id = v_actor
     AND p.client_request_id = p_client_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned_fixture_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.step_count IS DISTINCT FROM (CASE WHEN p_case_id = 3 THEN 2 ELSE 1 END)
     OR NOT EXISTS (
       SELECT 1 FROM app_private.copilot_plan_steps s
        WHERE s.plan_id = v_plan.id AND s.step_no = 1
          AND s.action_id = 'income_expense.create_draft'
          AND s.status = 'DONE'
          AND s.outcome ->> 'entity_table' = 'income_expenses'
          AND s.outcome ->> 'entity_id' = p_voucher_id::text
     ) THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.* INTO v_step
    FROM app_private.copilot_plan_steps s
   WHERE s.plan_id = v_plan.id AND s.step_no = 1;
  SELECT count(*) INTO v_ledger_count
    FROM app_private.copilot_action_ledger l
   WHERE l.plan_id = v_plan.id
     AND l.step_no = 1
     AND l.event = 'step_done'
     AND l.action_id = 'income_expense.create_draft'
     AND l.organization_id = p_organization_id
     AND l.user_id = v_actor
     AND l.entity_table = 'income_expenses'
     AND l.entity_id = p_voucher_id;
  SELECT l.* INTO v_ledger
    FROM app_private.copilot_action_ledger l
   WHERE l.id = v_step.ledger_id
     AND l.plan_id = v_plan.id
     AND l.step_no = 1
     AND l.event = 'step_done'
     AND l.action_id = 'income_expense.create_draft'
     AND l.organization_id = p_organization_id
     AND l.user_id = v_actor
     AND l.entity_table = 'income_expenses'
     AND l.entity_id = p_voucher_id;
  IF v_ledger_count <> 1 OR NOT FOUND OR v_ledger.audit_id IS NULL THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT a.* INTO v_audit
    FROM public.ai_write_audit a
   WHERE a.id = v_ledger.audit_id
     AND a.organization_id = p_organization_id
     AND a.user_id = v_actor
     AND a.tool = 'tao_phieu_thu_chi_nhap'
     AND a.entity_table = 'income_expenses'
     AND a.entity_id = p_voucher_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT ie.* INTO v_voucher
    FROM public.income_expenses ie
   WHERE ie.id = p_voucher_id
     AND ie.organization_id = p_organization_id
     AND ie.user_id = v_actor
     AND ie.name = 'E2E G3 g3:' || p_case_id::text || ':' || p_attempt_id::text
     AND ie.type = 'EXPENSE'
     AND ie.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned_fixture_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Case 3 can reach cleanup in either of two safe terminal paths: the submit
  -- step completed and its exact request was withdrawn, or it had no effect and
  -- the plan itself became terminal. A failed/skipped/blocked submit must never
  -- be mistaken for a request that this proof did not bind.
  IF p_case_id = 3 THEN
    SELECT s.* INTO v_step_two
      FROM app_private.copilot_plan_steps s
     WHERE s.plan_id = v_plan.id AND s.step_no = 2;
    IF NOT FOUND
       OR v_step_two.action_id IS DISTINCT FROM 'income_expense.nop_ho_so'
       OR v_step_two.ref_step IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*) INTO v_request_count
      FROM public.approval_requests r
     WHERE r.organization_id = p_organization_id
       AND r.subject_type = 'FINANCIAL_VOUCHER'
       AND r.subject_id = v_voucher.id;

    IF v_step_two.status = 'DONE' THEN
      IF v_request_count <> 1
         OR v_step_two.outcome ->> 'entity_table' IS DISTINCT FROM 'approval_requests'
         OR v_step_two.outcome ->> 'entity_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
         OR NOT EXISTS (
           SELECT 1 FROM public.approval_requests r
            WHERE r.id::text = v_step_two.outcome ->> 'entity_id'
              AND r.organization_id = p_organization_id
              AND r.subject_type = 'FINANCIAL_VOUCHER'
              AND r.subject_id = v_voucher.id
              AND r.maker_user_id = v_actor
              AND r.state = 'CANCELLED'
         )
         OR NOT EXISTS (
           SELECT 1 FROM app_private.copilot_action_ledger l
            WHERE l.plan_id = v_plan.id
              AND l.step_no = 2
              AND l.event = 'step_done'
              AND l.action_id = 'income_expense.nop_ho_so'
              AND l.organization_id = p_organization_id
              AND l.user_id = v_actor
              AND l.entity_table = 'approval_requests'
              AND l.entity_id::text = v_step_two.outcome ->> 'entity_id'
         ) THEN
        RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_step_two.status IN ('FAILED', 'BLOCKED', 'SKIPPED') THEN
      IF v_plan.status NOT IN ('FAILED', 'CANCELLED', 'EXPIRED')
         OR v_step_two.outcome IS NOT NULL
         OR v_request_count <> 0
         OR EXISTS (
           SELECT 1 FROM app_private.copilot_action_ledger l
            WHERE l.plan_id = v_plan.id
              AND l.step_no = 2
              AND (l.event = 'step_done' OR l.entity_id IS NOT NULL OR l.audit_id IS NOT NULL)
         ) THEN
        RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.approval_requests r
     WHERE r.organization_id = p_organization_id
       AND r.subject_type = 'FINANCIAL_VOUCHER'
       AND r.subject_id = v_voucher.id
  ) THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_item_count
    FROM public.income_expense_items it
   WHERE it.income_expense_id = v_voucher.id
     AND it.organization_id = p_organization_id;
  SELECT it.* INTO v_item
    FROM public.income_expense_items it
   WHERE it.income_expense_id = v_voucher.id
     AND it.organization_id = p_organization_id
   ORDER BY it.id
   LIMIT 1;
  IF v_item_count <> 1
     OR v_item.income_expense_id IS DISTINCT FROM v_voucher.id
     OR v_item.description IS DISTINCT FROM v_voucher.name
     OR v_item.quantity IS DISTINCT FROM 1
     OR v_item.unit_price IS DISTINCT FROM v_voucher.total_amount
     OR v_voucher.account_id IS NOT NULL
     OR v_voucher.active_posting_id_v2 IS NOT NULL
     OR v_voucher.reversed_by_posting_id IS NOT NULL
     OR v_voucher.contract_id IS NOT NULL
     OR v_voucher.invoice_id IS NOT NULL
     OR v_voucher.room_id IS NOT NULL
     OR v_voucher.system_source IS NOT NULL
     OR v_voucher.payment_id IS NOT NULL
     OR v_voucher.payment_collection_id IS NOT NULL
     OR v_voucher.salary_staff_id IS NOT NULL
     OR v_voucher.shareholder_id IS NOT NULL
     OR v_voucher.profit_manager_id IS NOT NULL
     OR v_voucher.reversal_of_income_expense_id IS NOT NULL
     OR v_voucher.handover_id IS NOT NULL
     OR v_voucher.handover_transfer_id IS NOT NULL
     OR v_voucher.posting_id IS NOT NULL
     OR v_voucher.posted_at_v2 IS NOT NULL
     OR EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership f WHERE f.income_expense_id = v_voucher.id)
     OR EXISTS (SELECT 1 FROM public.profit_payout_reservations r WHERE r.payout_voucher_id = v_voucher.id) THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  v_ownership_material := concat_ws('|',
    'g3-owned-v1', v_voucher.id::text, v_voucher.organization_id::text,
    v_voucher.user_id::text, v_voucher.name, v_voucher.type,
    v_voucher.total_amount::text, v_voucher.building_id::text,
    v_voucher.voucher_date::text, v_item.income_expense_type_id::text,
    v_item.id::text, v_item.quantity::text, v_item.unit_price::text);
  v_ownership_digest := encode(extensions.digest(convert_to(v_ownership_material, 'UTF8'), 'sha256'), 'hex');
  IF v_ownership_digest IS DISTINCT FROM p_expected_ownership_digest THEN
    RAISE EXCEPTION 'owned_fixture_binding_changed' USING ERRCODE = 'P0001';
  END IF;

  v_state_material := concat_ws('|',
    'g3-owned-state-v1', v_ownership_digest, v_voucher.approval_status,
    v_voucher.review_state, v_voucher.posting_status,
    coalesce(v_voucher.cancellation_kind, '<null>'),
    coalesce(v_voucher.active_posting_id_v2::text, '<null>'),
    coalesce(v_voucher.reversed_by_posting_id::text, '<null>'),
    v_voucher.approval_version::text, v_voucher.posting_version::text);
  v_state_digest := encode(extensions.digest(convert_to(v_state_material, 'UTF8'), 'sha256'), 'hex');
  IF v_state_digest IS DISTINCT FROM p_expected_state_digest
     OR v_voucher.approval_version IS DISTINCT FROM p_expected_approval_version
     OR v_voucher.posting_version IS DISTINCT FROM p_expected_posting_version THEN
    RAISE EXCEPTION 'owned_fixture_state_changed' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.income_expense_postings p
        WHERE p.voucher_id = v_voucher.id
           OR (p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v_voucher.id)
     )
     OR EXISTS (
       SELECT 1 FROM public.income_expense_posting_lines line
        JOIN public.income_expense_postings p ON p.id = line.posting_id
       WHERE p.voucher_id = v_voucher.id
          OR (p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v_voucher.id)
     )
     OR EXISTS (
       SELECT 1 FROM public.income_expense_recognition_adjustments adjustment
        WHERE adjustment.voucher_id = v_voucher.id
     ) THEN
    RAISE EXCEPTION 'owned_fixture_history_present' USING ERRCODE = 'P0001';
  END IF;

  IF p_phase = 'before_cancel' THEN
    IF v_voucher.approval_status IS DISTINCT FROM 'UNAPPROVED'
       OR v_voucher.posting_status IS DISTINCT FROM 'UNPOSTED'
       OR v_voucher.cancellation_kind IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM public.approval_requests r
          WHERE r.organization_id = p_organization_id
            AND r.subject_type = 'FINANCIAL_VOUCHER'
            AND r.subject_id = v_voucher.id
            AND r.state IN ('PENDING_APPROVAL', 'POSTED')
       ) THEN
      RAISE EXCEPTION 'owned_fixture_state_changed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_voucher.approval_status IS DISTINCT FROM 'CANCELLED'
     OR v_voucher.review_state IS DISTINCT FROM 'RESOLVED'
     OR v_voucher.posting_status IS DISTINCT FROM 'UNPOSTED'
     OR v_voucher.cancellation_kind IS DISTINCT FROM 'CANCELLED_UNPOSTED'
     OR NOT EXISTS (
       SELECT 1 FROM app_private.income_expense_cancellations c
        WHERE c.income_expense_id = v_voucher.id
          AND c.organization_id = p_organization_id
          AND c.cancelled_by = v_actor
          AND c.cancellation_kind = 'CANCELLED_UNPOSTED'
          AND c.cancel_reason = 'G3 cleanup ' || v_voucher.name
     ) THEN
    RAISE EXCEPTION 'owned_fixture_state_changed' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'attemptId', p_attempt_id,
    'caseId', p_case_id,
    'organizationId', p_organization_id,
    'planId', p_plan_id,
    'voucherId', p_voucher_id,
    'phase', p_phase,
    'checkedAt', v_checked_at,
    'expectedSnapshotMatched', true,
    'approvalVersion', v_voucher.approval_version,
    'postingVersion', v_voucher.posting_version,
    'ownershipVerified', true,
    'postingHistoryComplete', true,
    'zeroPostingHistory', true,
    'noActivePosting', true,
    'noRecognitionAdjustment', true,
    'noUnexpectedFinancialLink', true,
    'cancelledUnpostedVerified', p_phase = 'cancelled'
  );
END
$proof$;

REVOKE ALL ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) FROM anon;
REVOKE ALL ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) FROM service_role;
REVOKE ALL ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) TO authenticated;
COMMENT ON FUNCTION public.copilot_g3_owned_voucher_history_proof_v1(uuid,uuid,int,text,uuid,uuid,int,text,text,bigint,bigint,text) IS
  'Read-only, fail-closed proof that one exact caller-owned DEMO G3 fixture has no posting, line, recognition adjustment, or unexpected financial link. It returns a fixed sanitized receipt only.';
NOTIFY pgrst, 'reload schema';
COMMIT;
