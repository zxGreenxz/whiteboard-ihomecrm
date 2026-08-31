-- Forward-only hardening for the shared income/expense compat writer.
--
-- The preceding hardening migration creates a private, transaction-bound
-- capability.  This migration installs the writer that consumes that
-- capability and enables it only after the replacement is complete.
-- The private copilot_writer_context is represented by
-- app_private.copilot_ie_writer_context_v1; it is never supplied by a client
-- session setting.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- Keep this migration replayable on a baseline that does not yet contain the
-- preceding capability migration.  The normal forward lane runs the two files
-- in order; the idempotency gate deliberately replays each file independently.
CREATE TABLE IF NOT EXISTS app_private.copilot_ie_writer_context_v1 (
  transaction_id  text PRIMARY KEY,
  actor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  context_name    text NOT NULL,
  marker_digest   bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS copilot_ie_writer_context_created_idx
  ON app_private.copilot_ie_writer_context_v1 (created_at);

REVOKE ALL ON app_private.copilot_ie_writer_context_v1
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app_private.copilot_ie_writer_capabilities_v1 (
  capability_key text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  writer_version text NOT NULL DEFAULT 'disabled',
  enabled_at     timestamptz
);

INSERT INTO app_private.copilot_ie_writer_capabilities_v1
  (capability_key, enabled, writer_version)
VALUES ('income_expense_draft_v1', false, 'disabled')
ON CONFLICT (capability_key) DO NOTHING;

REVOKE ALL ON app_private.copilot_ie_writer_capabilities_v1
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.copilot_ie_writer_ready_v1(
  p_actor uuid,
  p_org uuid,
  p_marker text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public, extensions
AS $ready$
  SELECT p_marker IS NOT NULL
     AND btrim(p_marker) <> ''
     AND p_actor IS NOT DISTINCT FROM auth.uid()
     AND EXISTS (
       SELECT 1
         FROM app_private.copilot_ie_writer_capabilities_v1 c
        WHERE c.capability_key = 'income_expense_draft_v1'
          AND c.enabled
     )
     AND EXISTS (
       SELECT 1
         FROM app_private.copilot_ie_writer_context_v1 c
        WHERE c.transaction_id = pg_current_xact_id()::text
          AND c.actor_id = p_actor
          AND c.organization_id = p_org
          AND c.context_name = 'copilot_execute_income_expense_v1'
          AND c.marker_digest = extensions.digest(
                convert_to(p_marker, 'UTF8'), 'sha256')
          AND c.created_at > clock_timestamp() - interval '10 minutes'
     );
$ready$;

REVOKE ALL ON FUNCTION app_private.copilot_ie_writer_ready_v1(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_org              uuid;
  v_colrec           record;
  v_defj             jsonb;
  v_actor            record;
  v_id               uuid;
  v_clean            jsonb;
  v_item             jsonb;
  v_items            jsonb := coalesce(p_items, '[]'::jsonb);
  v_draft_marker     text := nullif(btrim(coalesce(p_row ->> 'copilot_draft_marker', '')), '');
  v_copilot_draft    boolean := false;
  v_input_item       jsonb;
  v_item_type_id     uuid;
  v_item_quantity    numeric;
  v_item_unit_price  numeric;
  v_item_amount      numeric;
BEGIN
  -- A browser can send a marker-shaped field, but only the execute RPC can
  -- create a matching private row in this transaction.  Delete the row here
  -- so the capability is single-use even if the writer is called twice.
  IF v_draft_marker IS NOT NULL THEN
    DELETE FROM app_private.copilot_ie_writer_context_v1 c
     WHERE c.transaction_id = pg_current_xact_id()::text
       AND c.actor_id = auth.uid()
       AND c.context_name = 'copilot_execute_income_expense_v1'
       AND c.marker_digest = extensions.digest(
             convert_to(v_draft_marker, 'UTF8'), 'sha256')
       AND c.created_at > clock_timestamp() - interval '10 minutes'
       AND EXISTS (
         SELECT 1
           FROM app_private.copilot_ie_writer_capabilities_v1 cap
          WHERE cap.capability_key = 'income_expense_draft_v1'
            AND cap.enabled
       )
    RETURNING c.organization_id INTO v_org;
    v_copilot_draft := FOUND;
  END IF;

  IF v_copilot_draft THEN
    -- The private context owns organization identity.  A mismatching payload
    -- is an invariant failure, not a chance to fall back to another org.
    BEGIN
      IF (p_row ->> 'organization_id') IS NOT NULL
         AND (p_row ->> 'organization_id')::uuid IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
    END;
  ELSE
    -- Preserve the established resolution behavior for ordinary callers.
    v_org := COALESCE(
      (SELECT a.organization_id
         FROM public.accounts a
        WHERE a.id = (p_row ->> 'account_id')::uuid),
      (SELECT b.organization_id
         FROM public.buildings b
        WHERE b.id = (p_row ->> 'building_id')::uuid),
      (p_row ->> 'organization_id')::uuid);
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org
        FROM public.organization_memberships m
       WHERE m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
       LIMIT 1;
    END IF;
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- Preserve the existing possession guard for callers that select a book.
  -- The Copilot path always strips account_id before the insert.
  IF (p_row ->> 'account_id') IS NOT NULL AND NOT v_copilot_draft THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org
         AND b.cashbook_id = (p_row ->> 'account_id')::uuid
         AND b.membership_id = v_actor.membership_id
         AND b.valid_to IS NULL
         AND (b.possession_kind = 'CUSTODIAN'
              OR (b.possession_kind = 'KNOWER'
                  AND COALESCE(p_row ->> 'type', '') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'cashbook possession is not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_copilot_draft THEN
    -- Re-resolve the building and item type inside the writer.  The execute
    -- RPC checks these too, but this is the final server-side boundary before
    -- a shared writer and its triggers observe any values.
    IF upper(coalesce(p_row ->> 'type', '')) NOT IN ('INCOME', 'EXPENSE') THEN
      RAISE EXCEPTION 'copilot type is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM public.buildings b
         WHERE b.id = (p_row ->> 'building_id')::uuid
           AND b.organization_id = v_org
           AND b.deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'copilot building is not in organization' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot building is invalid' USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) <> 1 THEN
      RAISE EXCEPTION 'copilot requires exactly one item' USING ERRCODE = '22023';
    END IF;
    v_input_item := v_items -> 0;
    IF jsonb_typeof(v_input_item) <> 'object' THEN
      RAISE EXCEPTION 'copilot item must be an object' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_item_type_id := NULLIF(v_input_item ->> 'income_expense_type_id', '')::uuid;
      v_item_quantity := COALESCE(NULLIF(v_input_item ->> 'quantity', '')::numeric, 1);
      v_item_unit_price := NULLIF(v_input_item ->> 'unit_price', '')::numeric;
      v_item_amount := NULLIF(v_input_item ->> 'amount', '')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'copilot item amount or type is invalid' USING ERRCODE = '22023';
    END;
    IF v_item_type_id IS NULL OR v_item_quantity IS NULL
       OR v_item_quantity <> 1 THEN
      RAISE EXCEPTION 'copilot item quantity or type is invalid' USING ERRCODE = '22023';
    END IF;
    IF v_item_unit_price IS NULL THEN
      v_item_unit_price := v_item_amount;
    END IF;
    IF v_item_amount IS NULL THEN
      v_item_amount := v_item_quantity * v_item_unit_price;
    END IF;
    IF v_item_unit_price IS NULL OR v_item_amount IS NULL
       OR v_item_unit_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_unit_price <= 0
       OR v_item_amount <= 0
       OR v_item_amount IS DISTINCT FROM v_item_quantity * v_item_unit_price THEN
      RAISE EXCEPTION 'copilot item amount is invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.income_expense_types t
     WHERE t.id = v_item_type_id
       AND t.organization_id = v_org
       AND lower(t.type) = lower(p_row ->> 'type')
       AND NOT coalesce(t.system_only, false)
       AND (
         NOT coalesce(t.is_restricted, false)
         OR public.can_create_restricted_ie()
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'copilot income/expense type is not permitted' USING ERRCODE = '42501';
    END IF;

    -- Rebuild the line from the allowlist.  Client-supplied organization,
    -- accounting class, lifecycle, and arbitrary columns never reach INSERT.
    v_items := jsonb_build_array(
      jsonb_build_object(
        'income_expense_type_id', v_item_type_id,
        'organization_id',        v_org,
        'description',            COALESCE(
          NULLIF(btrim(v_input_item ->> 'description'), ''),
          p_row ->> 'name'),
        'quantity',               1,
        'unit_price',             v_item_unit_price,
        'amount',                 v_item_amount
      )
    );
  END IF;

  -- Strip server-owned fields before applying the mode-specific values.
  v_clean := p_row - ARRAY[
    'approval_status', 'approved_by', 'approved_at', 'posting_id',
    'posted_at_v2', 'posting_mode', 'posting_status', 'active_posting_id_v2',
    'reversed_by_posting_id', 'deleted_at', 'maker_user_id',
    'maker_membership_id', 'birth_operation_id', 'birth_txid', 'review_state',
    'organization_id', 'user_id', 'copilot_draft_marker', 'copilot_draft_only'
  ]::text[];

  v_clean := v_clean || jsonb_build_object(
    'organization_id', v_org,
    'user_id', auth.uid(),
    'approval_status', CASE
      WHEN v_copilot_draft THEN 'UNAPPROVED'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'APPROVED'
      ELSE 'UNAPPROVED'
    END,
    'review_state', CASE
      WHEN v_copilot_draft THEN 'PENDING'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'RESOLVED'
      ELSE 'PENDING'
    END,
    'approved_by', CASE
      WHEN v_copilot_draft THEN NULL::uuid
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN auth.uid()
      ELSE NULL::uuid
    END,
    'approved_at', CASE
      WHEN v_copilot_draft THEN NULL::timestamptz
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN now()
      ELSE NULL::timestamptz
    END,
    'posting_mode', 'CASHBOOK',
    'posting_status', 'UNPOSTED',
    'maker_user_id', auth.uid(),
    'maker_membership_id', v_actor.membership_id
  );

  -- Ordinary callers retain the established user override; the Copilot
  -- branch above always keeps the authenticated actor as the owner.
  IF NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object(
      'user_id', COALESCE((p_row ->> 'user_id')::uuid, auth.uid())
    );
  END IF;

  IF p_row ? 'id' AND NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object('id', (p_row ->> 'id')::uuid);
  END IF;

  IF v_copilot_draft THEN
    -- Draft mode has no cashbook, posting, approval, recurrence, or source
    -- linkage.  Derived accounting fields are left to their server triggers.
    v_clean := (v_clean - ARRAY[
      'id', 'code', 'account_id', 'contract_id', 'invoice_id', 'payment_id',
      'payment_collection_id', 'handover_id', 'handover_transfer_id',
      'room_id', 'bed_id', 'tenant_id', 'shareholder_id', 'utility_account_id',
      'approval_request_id', 'approval_version', 'posting_version',
      'review_version', 'review_reason', 'review_deadline',
      'review_owner_membership_id', 'verified_at', 'verified_by',
      'verified_by_name', 'verified_note', 'cancellation_kind',
      'source_payload_hash', 'recognition_source_mode', 'recognition_date',
      'system_source', 'idempotency_key', 'business_result_accounting',
      'counts_in_business_result', 'has_restricted_item', 'kqkd_amount',
      'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_auto_approve',
      'repeat_next_date', 'repeat_parent_id', 'repeat_remaining',
      'active_posting_id_v2', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'approved_by', 'approved_at', 'review_state',
      'posting_mode', 'posting_status', 'total_amount'
    ]::text[]) || jsonb_build_object(
      'account_id', NULL::uuid,
      'contract_id', NULL::uuid,
      'invoice_id', NULL::uuid,
      'payment_id', NULL::uuid,
      'room_id', NULL::uuid,
      'bed_id', NULL::uuid,
      'tenant_id', NULL::uuid,
      'approval_status', 'UNAPPROVED',
      'review_state', 'PENDING',
      'approved_by', NULL::uuid,
      'approved_at', NULL::timestamptz,
      'posting_mode', 'CASHBOOK',
      'posting_status', 'UNPOSTED',
      'repeat_cycle', 'NONE',
      'repeat_infinity', false,
      'repeat_count', 0,
      'repeat_auto_approve', false,
      'repeat_next_date', NULL::date,
      'repeat_parent_id', NULL::uuid,
      'repeat_remaining', 0,
      'total_amount', v_item_amount
    );
  END IF;

  -- jsonb_populate_record makes absent columns explicit NULLs, so preserve
  -- the established generic default-fill behavior for NOT NULL columns.
  IF (v_clean ->> 'total_amount') IS NULL THEN
    v_clean := v_clean || jsonb_build_object('total_amount', COALESCE((
      SELECT SUM(COALESCE((i ->> 'amount')::numeric,
                          COALESCE((i ->> 'quantity')::numeric, 1)
                          * COALESCE((i ->> 'unit_price')::numeric, 0)))
        FROM jsonb_array_elements(v_items) i), 0));
  END IF;

  FOR v_colrec IN
    SELECT c.column_name, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'income_expenses'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean ->> v_colrec.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
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
      IF (v_item ->> v_colrec.column_name) IS NULL THEN
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
    'approval_status', (SELECT approval_status
                          FROM public.income_expenses
                         WHERE id = v_id)
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) IS
  'Shared compat writer. A private transaction-bound Copilot capability forces a single server-rebuilt draft; ordinary callers retain the established approval policy.';

-- Do not enable the capability until CREATE OR REPLACE above has succeeded.
UPDATE app_private.copilot_ie_writer_capabilities_v1
   SET enabled = true,
       writer_version = 'draft-v1',
       enabled_at = clock_timestamp()
 WHERE capability_key = 'income_expense_draft_v1';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM app_private.copilot_ie_writer_capabilities_v1
     WHERE capability_key = 'income_expense_draft_v1'
       AND enabled
       AND writer_version = 'draft-v1'
  ) THEN
    RAISE EXCEPTION 'Copilot draft writer capability was not enabled';
  END IF;
END
$verify$;

COMMIT;

-- Rollback: restore the prior ie_compat_insert_v2 definition from the current
-- production catalog or the immutable finance migration chain. Do not replay
-- historical migrations in place.
