-- Include the maker of a shareholder voucher only in an eligible single-step
-- company approval. Resolve candidates at submission, retain the original rule
-- matcher and preserve the generation and decisions of previously submitted requests.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  patch record;
  def text;
BEGIN
  FOR patch IN SELECT * FROM (VALUES
    ('app_private.materialize_step_candidates_v1(uuid)'::regprocedure,
     $old$and m.id <> v_req.maker_membership_id
    and m.user_id <> v_req.maker_user_id$old$,
     $new$and (
      (m.id <> v_req.maker_membership_id and m.user_id <> v_req.maker_user_id)
      or (
        m.id = v_req.maker_membership_id and m.user_id = v_req.maker_user_id
        and m.user_id = auth.uid()
        and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
        and (m.valid_to is null or m.valid_to > now())
        and v_req.subject_type = 'FINANCIAL_VOUCHER'
        and v_req.system_source = 'profit.ledger_payout'
        and v_req.rule_effect = 'REQUIRE_APPROVAL' and v_req.state = 'PENDING_APPROVAL'
        and v_step.organization_id = v_req.organization_id
        and v_step.step_no = 1 and v_step.mode = 'ANY' and v_step.min_approvals = 1
        and sa.organization_id = v_req.organization_id
        and sa.approver_type = 'PERMISSION' and sa.permission_key = 'income_expenses.approve'
        and exists (select 1 from public.approval_rule_steps rs
                     where rs.id = v_rule_step_id and rs.organization_id = v_req.organization_id
                       and rs.rule_id = v_req.matched_rule_id)
        and not exists (select 1 from public.approval_rule_steps rs
                         where rs.organization_id = v_req.organization_id
                           and rs.rule_id = v_req.matched_rule_id and rs.id <> v_rule_step_id)
        and exists (select 1 from app_private.profit_ledger_payouts p
                     where p.organization_id = v_req.organization_id and p.voucher_id = v_req.subject_id
                       and p.subject_kind = 'SHAREHOLDER' and p.maker_kind = 'OWNER'
                       and p.maker_user_id = m.user_id and p.maker_membership_id = m.id)
        and app_private.profit_advance_maker_kind_v1(v_req.organization_id, false) = 'OWNER'
        and (select allowed from app_private.authorize_tenant_action_v3(
          m.user_id, v_req.organization_id, 'shareholder_profit.distribute', v_req.building_id, v_req.cashbook_id))
      )
    )$new$),
    ('public.profit_ledger_payout_detail_v1(uuid)'::regprocedure,
     $old$'maker_kind', v_c2.maker_kind,$old$,
     $new$'maker_kind', v_c2.maker_kind,
      'payout_kind', (SELECT e.payload->>'payout_kind' FROM app_private.profit_ledger_events e
                       WHERE e.organization_id = v_ie.organization_id AND e.voucher_id = p_voucher_id
                         AND e.event_kind = 'PAYOUT_CREATED' AND e.payload->>'payout_kind' IN ('ADVANCE','SETTLEMENT')
                       LIMIT 1),$new$),
    ('app_private.guard_profit_ledger_payout_v1()'::regprocedure,
     $old$IF v_uid = v_p.maker_user_id AND NOT v_chu_tu THEN$old$,
     $new$IF v_chu_tu AND v_p.subject_kind = 'SHAREHOLDER' AND v_uid = v_p.maker_user_id THEN
    -- Both approval-only and approve-and-post enter this trigger. Recheck the current
    -- role and the actual assignment captured when the voucher was submitted.
    v_chu_tu := app_private.profit_advance_maker_kind_v1(OLD.organization_id, false) = 'OWNER'
      AND EXISTS (
        SELECT 1 FROM public.approval_request_steps st
        JOIN public.approval_request_step_candidates c
          ON c.request_step_id = st.id AND c.organization_id = st.organization_id
         AND c.generation = st.current_generation AND c.valid_to IS NULL AND c.eligible_at_submit
        JOIN public.organization_memberships m
          ON m.id = c.membership_id AND m.organization_id = c.organization_id
        WHERE st.organization_id = OLD.organization_id AND st.request_id = v_req.id
          AND st.status = 'PENDING' AND st.step_no = 1 AND st.mode = 'ANY' AND st.min_approvals = 1
          AND m.id = v_p.maker_membership_id AND m.user_id = v_uid AND m.status = 'ACTIVE'
          AND COALESCE(m.valid_from,'-infinity'::timestamptz) <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
      );
  END IF;
  IF v_uid = v_p.maker_user_id AND NOT v_chu_tu THEN$new$)
  ) AS patches(signature, original, revised)
  LOOP
    def := replace(pg_get_functiondef(patch.signature), chr(13) || chr(10), chr(10));
    IF strpos(def, patch.revised) > 0 THEN CONTINUE; END IF;
    IF array_length(string_to_array(def, patch.original),1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected definition for %', patch.signature;
    END IF;
    EXECUTE replace(def, patch.original, patch.revised);
  END LOOP;
END
$migration$;

-- The legacy reject command requires an independent checker. Report whether the
-- inbox row belongs to its maker even if the later voucher-detail read fails.
DO $inbox$
DECLARE
  sig regprocedure := 'public.list_my_pending_approvals_v1()'::regprocedure;
  definition text;
  previous_acl aclitem[];
  description text;
  entry record;
BEGIN
  IF 'is_maker' = ANY ((SELECT proargnames FROM pg_proc WHERE oid=sig)::text[]) THEN RETURN; END IF;
  SELECT pg_get_functiondef(oid), coalesce(proacl,acldefault('f',proowner)),
         obj_description(oid,'pg_proc') INTO definition,previous_acl,description
    FROM pg_proc WHERE oid=sig AND proowner=current_user::regrole;
  IF definition IS NULL OR array_length(string_to_array(definition,'posting_version bigint)'),1) <> 2
     OR array_length(string_to_array(definition,'coalesce(ie.posting_version, 1)'),1) <> 2 THEN
    RAISE EXCEPTION 'Unexpected inbox signature or definition';
  END IF;
  definition := replace(definition,'posting_version bigint)','posting_version bigint, is_maker boolean)');
  definition := replace(definition,'coalesce(ie.posting_version, 1)',
                        'coalesce(ie.posting_version, 1), ar.maker_user_id = auth.uid()');
  DROP FUNCTION public.list_my_pending_approvals_v1() RESTRICT;
  EXECUTE definition;
  FOR entry IN SELECT DISTINCT grantee FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    WHERE p.oid='public.list_my_pending_approvals_v1()'::regprocedure AND grantee<>p.proowner LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.list_my_pending_approvals_v1() FROM ' ||
      CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE (entry.grantee::regrole)::text END;
  END LOOP;
  FOR entry IN SELECT * FROM aclexplode(previous_acl) WHERE grantee<>current_user::regrole::oid LOOP
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_v1() TO ' ||
      CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE (entry.grantee::regrole)::text END ||
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
  EXECUTE format('COMMENT ON FUNCTION public.list_my_pending_approvals_v1() IS %L',description);
END
$inbox$;
NOTIFY pgrst, 'reload schema';
COMMIT;
