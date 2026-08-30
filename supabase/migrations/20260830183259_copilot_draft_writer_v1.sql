-- Forward-only hardening for the shared income/expense compat writer.
--
-- Production currently auto-approves ordinary INCOME rows in
-- ie_compat_insert_v2. Copilot must still use that writer (so its guards and
-- birth/audit triggers remain authoritative), but must enter a draft state.
-- The mode is transaction-local and server-owned: the Copilot execute RPC sets
-- both GUCs after validating its nonce; the public compat RPC cannot activate
-- the mode by putting a field in JSON.

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(
  p_row jsonb,
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org uuid;
  v_colrec record;
  v_defj jsonb;
  v_actor record;
  v_id uuid;
  v_clean jsonb;
  v_item jsonb;
  v_writer_context text := current_setting('app.copilot_writer_context', true);
  v_draft_marker text := current_setting('app.copilot_draft_marker', true);
  v_copilot_draft boolean :=
    v_writer_context = 'copilot_execute_income_expense_v1'
    AND v_draft_marker IS NOT NULL
    AND v_draft_marker <> ''
    AND v_draft_marker = coalesce(p_row ->> 'copilot_draft_marker', '');
BEGIN
  v_org := COALESCE(
    (SELECT a.organization_id FROM public.accounts a WHERE a.id = (p_row->>'account_id')::uuid),
    (SELECT b.organization_id FROM public.buildings b WHERE b.id = (p_row->>'building_id')::uuid),
    (p_row->>'organization_id')::uuid);
  IF v_org IS NULL THEN
    SELECT m.organization_id INTO v_org
      FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
     LIMIT 1;
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- Preserve the existing possession guard. The Copilot path deliberately
  -- passes account_id NULL, but this remains authoritative for normal callers.
  IF (p_row->>'account_id') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org
         AND b.cashbook_id = (p_row->>'account_id')::uuid
         AND b.membership_id = v_actor.membership_id
         AND b.valid_to IS NULL
         AND (b.possession_kind = 'CUSTODIAN'
              OR (b.possession_kind = 'KNOWER'
                  AND COALESCE(p_row->>'type', '') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'cashbook possession is not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Client input never owns lifecycle, organization, actor, or posting fields.
  -- The marker is removed as well; it is only a proof that the server context
  -- was set by copilot_execute_income_expense_v1 in this transaction.
  v_clean := (p_row - 'approval_status' - 'approved_by' - 'approved_at' - 'posting_id'
              - 'posted_at_v2' - 'posting_mode' - 'posting_status'
              - 'active_posting_id_v2' - 'reversed_by_posting_id' - 'deleted_at'
              - 'maker_user_id' - 'maker_membership_id' - 'birth_operation_id'
              - 'birth_txid' - 'review_state' - 'organization_id' - 'user_id'
              - 'copilot_draft_marker' - 'copilot_draft_only')
             || jsonb_build_object(
                  'organization_id', v_org,
                  'user_id', COALESCE((p_row->>'user_id')::uuid, auth.uid()),
                  'approval_status',
                    CASE WHEN v_copilot_draft THEN 'UNAPPROVED'
                         WHEN COALESCE(p_row->>'type', '') = 'INCOME'
                              AND COALESCE(p_row->>'repeat_cycle', 'NONE') = 'NONE'
                         THEN 'APPROVED' ELSE 'UNAPPROVED' END,
                  'review_state',
                    CASE WHEN v_copilot_draft THEN 'PENDING'
                         WHEN COALESCE(p_row->>'type', '') = 'INCOME'
                              AND COALESCE(p_row->>'repeat_cycle', 'NONE') = 'NONE'
                         THEN 'RESOLVED' ELSE 'PENDING' END,
                  'approved_by',
                    CASE WHEN v_copilot_draft THEN NULL::jsonb
                         WHEN COALESCE(p_row->>'type', '') = 'INCOME'
                              AND COALESCE(p_row->>'repeat_cycle', 'NONE') = 'NONE'
                         THEN to_jsonb(auth.uid()) ELSE NULL::jsonb END,
                  'approved_at',
                    CASE WHEN v_copilot_draft THEN NULL::jsonb
                         WHEN COALESCE(p_row->>'type', '') = 'INCOME'
                              AND COALESCE(p_row->>'repeat_cycle', 'NONE') = 'NONE'
                         THEN to_jsonb(now()) ELSE NULL::jsonb END,
                  'posting_mode', 'CASHBOOK',
                  'posting_status', 'UNPOSTED',
                  'maker_user_id', auth.uid(),
                  'maker_membership_id', v_actor.membership_id);

  IF p_row ? 'id' THEN
    v_clean := v_clean || jsonb_build_object('id', (p_row->>'id')::uuid);
  END IF;

  -- Copilot is draft-only even if a future caller accidentally supplies a
  -- cashbook or recurring fields. Force these server-owned values before any
  -- BEFORE INSERT trigger can observe them.
  IF v_copilot_draft THEN
    v_clean := (v_clean - 'account_id' - 'active_posting_id_v2' - 'posting_id'
                - 'repeat_cycle' - 'repeat_infinity' - 'repeat_count'
                - 'repeat_auto_approve' - 'repeat_remaining')
               || jsonb_build_object(
                    'account_id', NULL,
                    'repeat_cycle', 'NONE',
                    'repeat_infinity', false,
                    'repeat_count', 0,
                    'repeat_auto_approve', false,
                    'repeat_remaining', 0);
  END IF;

  -- jsonb_populate_record does not apply a column default when a key is
  -- explicitly present as NULL, so retain the existing default-fill behavior.
  IF (v_clean->>'total_amount') IS NULL THEN
    v_clean := v_clean || jsonb_build_object('total_amount', COALESCE((
      SELECT SUM(COALESCE((i->>'amount')::numeric,
                          COALESCE((i->>'quantity')::numeric, 1)
                          * COALESCE((i->>'unit_price')::numeric, 0)))
        FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i), 0));
  END IF;

  FOR v_colrec IN
    SELECT c.column_name, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'income_expenses'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean->>v_colrec.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    v_item := (v_item - 'income_expense_id')
              || jsonb_build_object('income_expense_id', v_id);
    FOR v_colrec IN
      SELECT c.column_name, c.column_default
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'income_expense_items'
         AND c.is_nullable = 'NO'
         AND c.column_default IS NOT NULL
    LOOP
      IF (v_item->>v_colrec.column_name) IS NULL THEN
        EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
        v_item := v_item || jsonb_build_object(v_colrec.column_name, v_defj);
      END IF;
    END LOOP;
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items, v_item);
  END LOOP;

  INSERT INTO app_private.finance_v2_semantic_event_log
    (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES
    (v_org, 'COMPAT_INSERT', 'income_expenses', v_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());

  RETURN jsonb_build_object(
    'id', v_id,
    'approval_status', (SELECT approval_status FROM public.income_expenses WHERE id = v_id));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) IS
  'Shared compat writer. Normal callers retain the existing income approval policy. '
  'The Copilot execute RPC can activate a transaction-local server context that forces '
  'UNAPPROVED/UNPOSTED and strips account/recurrence fields before insert.';

COMMIT;

-- Rollback: restore the prior ie_compat_insert_v2 definition from the current
-- production catalog or the immutable finance migration chain. Do not replay
-- historical migrations in place.
