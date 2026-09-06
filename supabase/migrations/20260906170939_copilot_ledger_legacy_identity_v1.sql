-- G5-E: authenticated superadmin evidence only. No writer, policy or UI RPC changes.
-- A single JSON envelope prevents the PostgREST row cap from truncating metadata.
-- Pages use the ORIGINAL timestamp (microseconds) and UUID, ordered ascending.
-- No global policy events in tenant pages. Cross-org references disclose only match
-- booleans, never the referenced actor/org, payload, digest or idempotency key.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- One read-side identity adapter; it grants no execution authority. The current
-- registry contract must still describe the exact producer, even when disabled.
CREATE OR REPLACE FUNCTION app_private.copilot_audit_action_identity_v1(
  p_tool text, p_entity_table text, p_entity_id uuid
) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, app_private
AS $identity$
  SELECT CASE WHEN p_tool = 'tao_phieu_thu_chi_nhap'
    AND p_entity_table = 'income_expenses' AND p_entity_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM app_private.copilot_action_registry r
      WHERE r.action_id = 'income_expense.create_draft' AND r.version = 1
        AND r.risk = 'L4' AND r.executor_kind = 'nonce_abi_v1'
        AND r.permission_key = 'income_expenses.create' AND r.consent_required = 'click'
        AND r.preview_rpc = 'copilot_preview_income_expense_v1'
        AND r.execute_rpc = 'copilot_execute_income_expense_v1'
        AND r.verify_kind = 'ie_draft' AND r.produces_entity_table = 'income_expenses')
    THEN 'income_expense.create_draft' ELSE p_tool END
$identity$;
REVOKE ALL ON FUNCTION app_private.copilot_audit_action_identity_v1(text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.copilot_ledger_audit_page_v1(
  p_organization_id uuid, p_since timestamptz, p_until timestamptz,
  p_stream text DEFAULT 'ledger', p_after_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $function$
DECLARE
  v_registry jsonb; v_rows jsonb := '[]'::jsonb; v_total bigint; v_gaps bigint;
  v_row record; v_plan app_private.copilot_plans%ROWTYPE;
  v_conf app_private.copilot_write_confirmations%ROWTYPE;
  v_entity text; v_entity_org uuid; v_table text; v_consent text;
  v_origin app_private.copilot_action_ledger%ROWTYPE; v_origin_count bigint;
  v_chain text; v_external_status text;
  v_audit public.ai_write_audit%ROWTYPE; v_audit_action text; v_mapping text;
  v_item jsonb; v_actions bigint; v_steps bigint; v_duplicates boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'superadmin_required' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_since IS NULL OR p_until IS NULL
     OR NOT isfinite(p_since) OR NOT isfinite(p_until)
     OR p_since >= p_until OR p_until - p_since > interval '366 days'
     OR p_stream IS NULL OR p_stream NOT IN ('ledger', 'audit')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
     OR (p_after_at IS NULL) <> (p_after_id IS NULL)
     OR (p_after_at IS NOT NULL AND (p_after_at < p_since OR p_after_at >= p_until)) THEN
    RAISE EXCEPTION 'invalid_audit_window_or_cursor' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'action_id', r.action_id, 'executor_kind', r.executor_kind, 'risk', r.risk,
    'grantable', r.grantable, 'pin_always', r.pin_always) ORDER BY r.action_id), '[]')
    INTO v_registry FROM app_private.copilot_action_registry r;

  -- Reverse coverage: a DONE step must point to the matching immutable event.
  SELECT count(*) INTO v_gaps FROM app_private.copilot_plan_steps s
    JOIN app_private.copilot_plans p ON p.id = s.plan_id
   WHERE p.organization_id = p_organization_id AND s.status IN ('DONE', 'UNKNOWN_EFFECT')
     AND s.executed_at >= p_since AND s.executed_at < p_until
     AND NOT EXISTS (SELECT 1 FROM app_private.copilot_action_ledger l
       WHERE l.id = s.ledger_id AND l.plan_id = s.plan_id AND l.step_no = s.step_no
         AND l.action_id = s.action_id
         AND ((s.status = 'UNKNOWN_EFFECT' AND l.event = 'step_unknown_effect')
           OR (s.status = 'DONE' AND (l.event = 'step_done'
             OR (l.event = 'step_reconciled' AND l.outcome ->> 'reconciled_status' = 'DONE'
               AND EXISTS (SELECT 1 FROM app_private.copilot_action_ledger q
                 WHERE q.plan_id = l.plan_id AND q.step_no = l.step_no AND q.action_id = l.action_id
                   AND q.organization_id = l.organization_id AND q.user_id = p.user_id
                   AND q.event = 'step_unknown_effect' AND q.created_at < l.created_at
                   AND q.entity_table = l.outcome ->> 'entity_table'
                   AND q.entity_id::text = l.outcome ->> 'entity_id')))))
         AND l.organization_id = p.organization_id AND l.user_id = p.user_id);

  IF p_stream = 'audit' THEN
    SELECT count(*) INTO v_total FROM public.ai_write_audit a
      WHERE a.organization_id = p_organization_id AND a.created_at >= p_since AND a.created_at < p_until;
    FOR v_row IN SELECT a.*
      FROM public.ai_write_audit a
      WHERE a.organization_id = p_organization_id AND a.created_at >= p_since AND a.created_at < p_until
        AND (p_after_at IS NULL OR (a.created_at, a.id) > (p_after_at, p_after_id))
      ORDER BY a.created_at, a.id LIMIT p_limit
    LOOP
      v_audit_action := app_private.copilot_audit_action_identity_v1(v_row.tool, v_row.entity_table, v_row.entity_id);
      v_mapping := CASE WHEN v_audit_action IS DISTINCT FROM v_row.tool THEN 'legacy_income_expense_draft_v1' END;
      SELECT count(*) FILTER (WHERE l.event = 'action_executed'),
        count(*) FILTER (WHERE l.event IN ('step_done', 'step_unknown_effect') AND l.created_at >= p_since AND l.created_at < p_until)
        INTO v_actions, v_steps FROM app_private.copilot_action_ledger l
        WHERE l.audit_id = v_row.id AND l.organization_id = p_organization_id
          AND l.action_id = v_audit_action AND l.user_id = v_row.user_id
          AND l.entity_table IS NOT DISTINCT FROM v_row.entity_table
          AND l.entity_id IS NOT DISTINCT FROM v_row.entity_id;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'id', v_row.id, 'created_at', v_row.created_at, 'organization_id', v_row.organization_id,
        'action_id', v_audit_action, 'audit_id', v_row.id,
        'audit_tool', v_row.tool, 'identity_mapping', v_mapping,
        'duplicate_key', (SELECT count(*) > 1 FROM public.ai_write_audit a
           WHERE a.organization_id = p_organization_id AND a.idempotency_key = v_row.idempotency_key),
        'duplicate_executions', v_actions > 1, 'action_executions', v_actions, 'step_links', v_steps));
    END LOOP;
  ELSE
    SELECT count(*) INTO v_total FROM app_private.copilot_action_ledger l
      WHERE l.organization_id = p_organization_id AND l.created_at >= p_since AND l.created_at < p_until;
    FOR v_row IN SELECT l.* FROM app_private.copilot_action_ledger l
      WHERE l.organization_id = p_organization_id AND l.created_at >= p_since AND l.created_at < p_until
        AND (p_after_at IS NULL OR (l.created_at, l.id) > (p_after_at, p_after_id))
      ORDER BY l.created_at, l.id LIMIT p_limit
    LOOP
      SELECT * INTO v_plan FROM app_private.copilot_plans p WHERE p.id = v_row.plan_id;
      -- A reconciliation contains no audit/entity/digest columns: these belong to
      -- the original queue execution. Resolve one unambiguous immutable origin.
      v_origin := v_row; v_chain := NULL; v_external_status := NULL;
      IF v_row.event = 'step_reconciled' THEN
        SELECT count(*) INTO v_origin_count FROM app_private.copilot_action_ledger q
          WHERE q.plan_id = v_row.plan_id AND q.step_no = v_row.step_no
            AND q.action_id = v_row.action_id AND q.organization_id = p_organization_id
            AND q.event = 'step_unknown_effect' AND q.created_at < v_row.created_at;
        SELECT q.* INTO v_origin FROM app_private.copilot_action_ledger q
          WHERE q.plan_id = v_row.plan_id AND q.step_no = v_row.step_no
            AND q.action_id = v_row.action_id AND q.organization_id = p_organization_id
            AND q.event = 'step_unknown_effect' AND q.created_at < v_row.created_at
          ORDER BY q.created_at, q.id LIMIT 1;
        v_external_status := v_row.outcome ->> 'reconciled_status';
        v_chain := CASE WHEN v_origin_count = 1 AND v_origin.user_id = v_plan.user_id
          AND v_origin.entity_table = v_row.outcome ->> 'entity_table'
          AND v_origin.entity_id::text = v_row.outcome ->> 'entity_id'
          AND v_origin.consent_kind IS NOT DISTINCT FROM v_row.consent_kind
          AND v_origin.step_up_id IS NOT DISTINCT FROM v_row.step_up_id
          AND EXISTS (SELECT 1 FROM app_private.copilot_plan_steps s
            WHERE s.plan_id = v_row.plan_id AND s.step_no = v_row.step_no
              AND s.action_id = v_row.action_id AND s.ledger_id = v_row.id
              AND s.status = v_external_status AND s.status IN ('DONE', 'FAILED'))
          THEN 'valid' ELSE 'invalid' END;
      ELSIF v_row.event = 'step_unknown_effect' THEN
        v_external_status := CASE WHEN EXISTS (
          SELECT 1 FROM app_private.copilot_action_ledger r
            WHERE r.organization_id = p_organization_id AND r.plan_id = v_row.plan_id
              AND r.step_no = v_row.step_no AND r.action_id = v_row.action_id
              AND r.event = 'step_reconciled' AND r.created_at > v_row.created_at
              AND r.created_at >= p_since AND r.created_at < p_until
              AND r.outcome ->> 'reconciled_status' IN ('DONE', 'FAILED')
          ) THEN 'resolved' ELSE 'pending' END;
      END IF;
      v_consent := 'missing';
      IF v_row.consent_kind = 'step_up' AND v_row.step_up_id IS NOT NULL THEN
        SELECT * INTO v_conf FROM app_private.copilot_write_confirmations c WHERE c.id = v_row.step_up_id;
        IF FOUND AND v_origin.id IS NOT NULL THEN
          v_consent := CASE WHEN v_conf.user_id = v_origin.user_id
            AND v_conf.organization_id = v_row.organization_id AND v_conf.tool = 'step_up'
            AND v_conf.permission_key = 'copilot.step_up' AND v_conf.consumed_at IS NOT NULL
            AND v_conf.consumed_at <= v_origin.created_at AND v_conf.consumed_at < v_conf.expires_at
            AND v_plan.step_up_confirmation_id = v_conf.id THEN 'valid' ELSE 'invalid' END;
        END IF;
      ELSIF v_row.consent_kind = 'standing_grant' AND v_plan.id IS NOT NULL THEN
        -- Current direct-L5 CHECK prohibits grants. Keep that policy intact.
        -- Future eligibility still requires the stored actor/org/action/time evidence.
        IF EXISTS (SELECT 1 FROM app_private.copilot_standing_grants g
          WHERE g.id = ANY(v_plan.standing_grant_ids) AND g.organization_id = v_row.organization_id
            AND g.granter_user_id = v_origin.user_id AND g.action_id = v_row.action_id
            AND g.created_at <= v_row.created_at AND g.expires_at > v_row.created_at
            AND (g.revoked_at IS NULL OR g.revoked_at > v_row.created_at)) THEN
          v_consent := 'valid';
        END IF;
      END IF;

      v_entity := 'not_applicable';
      IF v_row.event IN ('step_done', 'action_executed', 'step_unknown_effect', 'step_reconciled') THEN
        SELECT r.produces_entity_table INTO v_table FROM app_private.copilot_action_registry r WHERE r.action_id = v_row.action_id;
        IF v_origin.entity_table IS NOT NULL OR v_origin.entity_id IS NOT NULL OR v_table IS NOT NULL THEN
          v_entity := 'missing';
          IF v_origin.entity_table IS NOT NULL AND v_origin.entity_id IS NOT NULL THEN
            -- Only a registry-owned public table; no caller-supplied table name.
            IF v_origin.entity_table IS DISTINCT FROM v_table OR v_table !~ '^[a-z_][a-z0-9_]*$' THEN
              v_entity := 'unsupported';
            ELSIF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(format('public.%I', v_table))
                AND a.attname = 'organization_id' AND NOT a.attisdropped) THEN
              BEGIN
                EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', v_table)
                  INTO v_entity_org USING v_origin.entity_id;
                IF v_entity_org IS NOT NULL THEN
                  v_entity := CASE WHEN v_entity_org = v_row.organization_id THEN 'match' ELSE 'mismatch' END;
                END IF;
              EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege OR datatype_mismatch THEN
                v_entity := 'unreadable';
              END;
            ELSE
              -- No authoritative org column: do not silently call it zero wrong-org.
              v_entity := 'unsupported';
            END IF;
          END IF;
        END IF;
      END IF;
      SELECT a.* INTO v_audit FROM public.ai_write_audit a WHERE a.id = v_origin.audit_id;
      v_audit_action := app_private.copilot_audit_action_identity_v1(v_audit.tool, v_audit.entity_table, v_audit.entity_id);
      v_mapping := CASE WHEN v_audit.organization_id = p_organization_id
        AND v_audit_action IS DISTINCT FROM v_audit.tool THEN 'legacy_income_expense_draft_v1' END;
      SELECT count(*) FILTER (WHERE l.event = 'action_executed'),
        count(*) FILTER (WHERE l.event IN ('step_done', 'step_unknown_effect') AND l.created_at >= p_since AND l.created_at < p_until)
        INTO v_actions, v_steps FROM app_private.copilot_action_ledger l
        WHERE l.audit_id = v_origin.audit_id AND l.organization_id = p_organization_id
          AND l.action_id = v_row.action_id AND l.action_id = v_audit_action
          AND l.organization_id = v_audit.organization_id AND l.user_id = v_audit.user_id
          AND l.entity_table IS NOT DISTINCT FROM v_audit.entity_table
          AND l.entity_id IS NOT DISTINCT FROM v_audit.entity_id;
      -- step_done can be an idempotent replay referencing the same audit. Only
      -- duplicate wrapper execution records or duplicate non-replay plan steps count.
      SELECT v_actions > 1 OR count(*) > 1 INTO v_duplicates FROM app_private.copilot_action_ledger l
        WHERE l.organization_id = p_organization_id AND l.plan_id = v_row.plan_id
          AND l.step_no = v_row.step_no AND l.event IN ('step_done', 'step_unknown_effect')
          AND COALESCE(l.outcome ->> 'idempotent', 'false') <> 'true';
      v_item := jsonb_build_object(
        'id', v_row.id, 'created_at', v_row.created_at, 'organization_id', v_row.organization_id,
        'event', v_row.event, 'action_id', v_row.action_id, 'plan_id', v_row.plan_id, 'step_no', v_row.step_no,
        'consent_kind', v_row.consent_kind, 'consent_evidence', v_consent,
        'plan_present', v_plan.id IS NOT NULL,
        'plan_actor_matches', v_plan.user_id = v_row.user_id,
        'plan_org_matches', v_plan.organization_id = v_row.organization_id,
        'plan_consent_matches', v_plan.consent_kind IS NOT DISTINCT FROM v_row.consent_kind,
        'entity_evidence', v_entity, 'audit_id', v_origin.audit_id,
        'audit_tool', CASE WHEN v_audit.organization_id = p_organization_id THEN v_audit.tool END,
        'identity_mapping', v_mapping,
        'audit_present', EXISTS (SELECT 1 FROM public.ai_write_audit a WHERE a.id = v_origin.audit_id),
        'audit_org_matches', (SELECT a.organization_id = v_row.organization_id FROM public.ai_write_audit a WHERE a.id = v_origin.audit_id),
        'audit_actor_matches', (SELECT a.user_id = v_origin.user_id FROM public.ai_write_audit a WHERE a.id = v_origin.audit_id),
        'audit_matches', EXISTS (SELECT 1 FROM public.ai_write_audit a WHERE a.id = v_origin.audit_id
          AND a.organization_id = v_row.organization_id AND a.user_id = v_origin.user_id
          AND v_audit_action = v_row.action_id AND a.entity_table IS NOT DISTINCT FROM v_origin.entity_table
          AND a.entity_id IS NOT DISTINCT FROM v_origin.entity_id),
        'action_executions', v_actions, 'step_links', v_steps,
        'duplicate_executions', v_duplicates, 'has_after_digest', v_origin.after_digest IS NOT NULL,
        'idempotent', v_origin.outcome -> 'idempotent',
        'reconciliation_evidence', v_chain, 'external_effect_status', v_external_status);
      v_rows := v_rows || jsonb_build_array(v_item);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('version', 1, 'registry', v_registry, 'rows', v_rows,
    'total', v_total, 'missing_step_ledger', v_gaps);
END
$function$;

REVOKE ALL ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) FROM anon;
REVOKE ALL ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) TO authenticated;
COMMENT ON FUNCTION public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer) IS
  'Read-only superadmin evidence for one explicit org and bounded time window; no payload, digest, token or unrelated organization data. G5-E does not establish canary duration.';
NOTIFY pgrst, 'reload schema';
COMMIT;
