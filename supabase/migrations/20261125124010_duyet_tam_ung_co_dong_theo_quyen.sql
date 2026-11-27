-- Self approval of an advance is available under the ordinary single permission step.
-- Keep individually assigned workflows, settlement approvals and cashbook posting intact.
BEGIN;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('app_private.guard_profit_ledger_payout_v1()'::regprocedure);
  change record;
BEGIN
  IF strpos(definition, 'st.current_generation') = 0 THEN
    RAISE EXCEPTION 'Missing shareholder approval assignment guard';
  END IF;
  FOR change IN SELECT * FROM (VALUES
    ('v_chu_tu  boolean := false;', 'v_chu_tu  boolean := false;
  v_duyet_tam_ung boolean := false;'),
    ($old$IF v_uid = v_p.maker_user_id AND NOT v_chu_tu THEN$old$,
     $new$IF v_p.subject_kind = 'SHAREHOLDER' AND (v_uid = v_p.maker_user_id OR v_la_nhan) AND NOT v_chu_tu THEN
    v_duyet_tam_ung := (
      v_p.maker_kind IN ('CUSTODIAN_ADVANCE', 'CUSTODIAN_FOR_PAYEE')
      OR EXISTS (
        SELECT 1 FROM app_private.profit_ledger_events e
        WHERE e.organization_id = OLD.organization_id AND e.voucher_id = OLD.id
          AND e.event_kind = 'PAYOUT_CREATED' AND e.payload->>'payout_kind' = 'ADVANCE'
      )
    ) AND EXISTS (
      SELECT 1 FROM public.approval_requests ar
      JOIN public.approval_request_steps st ON st.request_id = ar.id AND st.organization_id = ar.organization_id
      JOIN public.approval_rule_steps rs ON rs.id = (st.rule_step_snapshot->>'rule_step_id')::uuid
        AND rs.rule_id = ar.matched_rule_id AND rs.organization_id = ar.organization_id
      JOIN public.approval_step_approvers sa ON sa.step_id = rs.id AND sa.organization_id = rs.organization_id
      WHERE ar.id = v_req.id AND ar.organization_id = OLD.organization_id
        AND ar.rule_effect = 'REQUIRE_APPROVAL' AND ar.state = 'PENDING_APPROVAL'
        AND st.status = 'PENDING' AND st.step_no = 1 AND st.mode = 'ANY' AND st.min_approvals = 1
        AND sa.approver_type = 'PERMISSION' AND sa.permission_key = 'income_expenses.approve'
        AND NOT EXISTS (SELECT 1 FROM public.approval_request_steps other
          WHERE other.organization_id = ar.organization_id AND other.request_id = ar.id AND other.id <> st.id)
    );
  END IF;
  IF v_uid = v_p.maker_user_id AND NOT (v_chu_tu OR v_duyet_tam_ung) THEN$new$),
    ('IF v_la_nhan AND NOT v_chu_tu THEN', 'IF v_la_nhan AND NOT (v_chu_tu OR v_duyet_tam_ung) THEN')
  ) AS changes(original, replacement)
  LOOP
    IF strpos(definition, change.replacement) > 0 THEN CONTINUE; END IF;
    IF array_length(string_to_array(definition, change.original), 1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected approval guard in app_private.guard_profit_ledger_payout_v1';
    END IF;
    definition := replace(definition, change.original, change.replacement);
  END LOOP;
  EXECUTE definition;
END
$migration$;

COMMENT ON FUNCTION app_private.guard_profit_ledger_payout_v1() IS
  'Duyệt tạm ứng cổ đông theo quyền chi lợi nhuận công ty và quyền duyệt thu chi tại toà khi quy trình có một bước duyệt theo quyền. Phiếu chốt chi giữ điều kiện phân công. Ghi chi kiểm riêng sổ quỹ và người nhận.';

COMMIT;
