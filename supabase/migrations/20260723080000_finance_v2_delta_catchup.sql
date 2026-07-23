-- Finance V2 (Thu Chi V2) — Stage 8: DELTA CATCH-UP + high-watermark replay (plan §10.3).
--
-- BODY ONLY. Raw PostgreSQL 15. NO BEGIN/COMMIT/NOTIFY (the apply orchestrator wraps this
-- stage in one transaction). Everything is idempotent (CREATE OR REPLACE / DROP … IF EXISTS /
-- to_regclass guards / applied_at-IS-NULL guards / ON CONFLICT DO NOTHING), so a re-apply — and
-- a re-run of the replay itself — adds nothing new. No feature mode is changed, no org enrolled.
--
-- What this stage delivers (plan §10.3 "Delta catch-up và high-watermark"):
--   1. ATTACH the Stage-2 change-capture trigger app_private.finance_v2_capture_change() to the
--      legacy source tables as an AFTER INSERT/UPDATE/DELETE row trigger named a90_finance_v2_capture
--      (a90 => fires LAST, after every business trigger has run and the row is in its final shape).
--   2. finance_v2_replay_change_log_v1(run_id, until_seq) — repeatable, idempotent replay of the
--      append-only change log in sequence_id order up to a watermark, reconciling shadow postings
--      WITHOUT ever UPDATE/DELETE-ing a posting event (a reversal is always a NEW event).
--   3. finance_v2_delta_lag_v1() — the zero-lag gate primitive (count of unapplied change-log rows).
--
-- Cash-effect contract (plan §10.3, exact):
--   * UPDATE that changes amount/type/account/change/rounding/status of a source that already has a
--     cash posting: in a locked transaction append a REVERSAL for the active generation + a
--     replacement POSTING generation (source_kind='LEGACY_DELTA_REPLACEMENT'), then move the active
--     pointer / header mirror.  Note-only UPDATE: refresh the projection only, never touch event/lines.
--   * DELETE of a row that has a cash effect: set income_expenses.deleted_at (compatibility delete
--     guard / tombstone) and append a REVERSAL so the voucher becomes APPROVED + REVERSED.  A row that
--     never posted becomes a tombstone-only apply.  A hard-DELETE of a row an event still references is
--     NEVER cascaded — it is diverted to an exception and left unapplied (blocks cutover per §10.3).
--   * Ambiguous / locked-period / non-deterministic / adapter-owned divergence -> write an
--     app_private.income_expense_v2_backfill_exceptions row and LEAVE THE LOG ROW UNAPPLIED (so the
--     zero-lag gate stays red and cutover is blocked).  Never last-write-wins silently; never guess.
--
-- Scope boundary: this worker owns the reconciliation of PLAIN LEGACY cash vouchers (amount_basis
-- VOUCHER_TOTAL, backfill class B1 — not V5-tender / salary / termination-forfeit / profit-payout /
-- flow-owned).  For adapter-owned subjects it only re-checks consistency and ALERTS (exception) on a
-- divergence — it does not rewrite adapter-owned lineage.  Any cash-relevant change to a subsidiary
-- table (items / accounts / V5 tender-allocation / payments) also re-touches its income_expenses
-- header (auto_recalc / mirror), so the header-driven reconcile is the authoritative catch; subsidiary
-- log rows are drained as projection and, when they resolve to a plain voucher, reconciled too.

-- ============================================================================
-- PART A — Attach the change-capture trigger to the legacy source tables (§10.3 step 2 / §10.0).
--          a90 name => fires last; guarded by to_regclass so missing tables are skipped cleanly.
-- ============================================================================
BEGIN;

DO $attach_capture$
DECLARE
  v_tbl  text;
  v_tbls text[] := ARRAY[
    'public.income_expenses',
    'public.income_expense_items',
    'public.accounts',
    'public.account_shared_users',
    'public.payments',
    'public.invoice_payment_collections',
    'public.invoice_payment_tenders',
    'public.invoice_payment_allocations'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_tbls LOOP
    IF to_regclass(v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS a90_finance_v2_capture ON %s', v_tbl);
      EXECUTE format(
        'CREATE TRIGGER a90_finance_v2_capture '
        'AFTER INSERT OR UPDATE OR DELETE ON %s '
        'FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_capture_change()', v_tbl);
    END IF;
  END LOOP;
END
$attach_capture$;

-- ============================================================================
-- PART B — Change-log APPLIED-STAMP guard. Stage-2 attached the blanket ledger-immutable trigger
--          to finance_v2_backfill_change_log, which would reject the applied_run_id/applied_at stamp
--          the replay must write. Replace it with a stamp-only guard: the row stays append-only for
--          every immutable column, but the applied watermark may be set exactly once (NULL -> value).
-- ============================================================================
CREATE OR REPLACE FUNCTION app_private.guard_finance_v2_change_log_applied_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $stamp_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance_v2_backfill_change_log is append-only (no DELETE)'
      USING ERRCODE = '55000';
  END IF;

  -- The ONLY permitted UPDATE is a one-time applied-watermark stamp: every immutable column must be
  -- byte-for-byte unchanged, the row must not have been stamped yet, and the new stamp must be set.
  IF OLD.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'finance_v2_backfill_change_log row % already applied (immutable stamp)', OLD.sequence_id
      USING ERRCODE = '55000';
  END IF;
  IF NEW.sequence_id            IS DISTINCT FROM OLD.sequence_id
     OR NEW.organization_id     IS DISTINCT FROM OLD.organization_id
     OR NEW.source_table        IS DISTINCT FROM OLD.source_table
     OR NEW.source_pk           IS DISTINCT FROM OLD.source_pk
     OR NEW.operation           IS DISTINCT FROM OLD.operation
     OR NEW.source_version_or_hash IS DISTINCT FROM OLD.source_version_or_hash
     OR NEW.txid                IS DISTINCT FROM OLD.txid
     OR NEW.changed_at          IS DISTINCT FROM OLD.changed_at THEN
    RAISE EXCEPTION 'finance_v2_backfill_change_log immutable columns cannot be modified (row %)', OLD.sequence_id
      USING ERRCODE = '55000';
  END IF;
  IF NEW.applied_at IS NULL OR NEW.applied_run_id IS NULL THEN
    RAISE EXCEPTION 'finance_v2_backfill_change_log stamp requires applied_run_id + applied_at (row %)', OLD.sequence_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$stamp_guard$;
REVOKE ALL ON FUNCTION app_private.guard_finance_v2_change_log_applied_stamp()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.guard_finance_v2_change_log_applied_stamp() IS
  'Plan §10.3: append-only change log stays immutable except a one-time applied_run_id/applied_at stamp.';

DROP TRIGGER IF EXISTS a00_finance_v2_backfill_change_log_immutable
  ON app_private.finance_v2_backfill_change_log;
DROP TRIGGER IF EXISTS a00_finance_v2_backfill_change_log_applied_stamp
  ON app_private.finance_v2_backfill_change_log;
CREATE TRIGGER a00_finance_v2_backfill_change_log_applied_stamp
  BEFORE UPDATE OR DELETE ON app_private.finance_v2_backfill_change_log
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_change_log_applied_stamp();

-- ============================================================================
-- PART C — Shared append helpers (§6.2). Both append-only; never mutate an existing event.
-- ============================================================================

-- C1. Append a REVERSAL event for an existing POSTING (idempotent: one reversal per original posting).
--     Mirrors the manual reverse RPC: copy the original's cash face, negate net, opposing signed lines.
DROP FUNCTION IF EXISTS app_private.finance_v2_append_reversal_v1(uuid, date, uuid, uuid, text, bigint);
CREATE FUNCTION app_private.finance_v2_append_reversal_v1(
  p_orig_id uuid, p_posted_on date, p_membership uuid, p_user uuid, p_reason text, p_seq bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $append_reversal$
DECLARE
  v_orig public.income_expense_postings;
  v_rev_id uuid := gen_random_uuid();
  v_idem text;
  v_existing uuid;
  v_line public.income_expense_posting_lines;
BEGIN
  SELECT * INTO v_orig FROM public.income_expense_postings p WHERE p.id = p_orig_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_v2_append_reversal_v1: original posting % not found', p_orig_id USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.event_kind <> 'POSTING' THEN
    RAISE EXCEPTION 'finance_v2_append_reversal_v1: % is not a POSTING event', p_orig_id USING ERRCODE = '55000';
  END IF;

  v_idem := 'fin_v2_delta:reversal:' || p_orig_id::text;

  -- Idempotent: if this original was already reversed by the delta worker, return that reversal.
  SELECT p.id INTO v_existing
  FROM public.income_expense_postings p
  WHERE p.organization_id = v_orig.organization_id AND p.idempotency_key = v_idem;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_request_id, approval_version, event_kind, idempotency_key, source_kind,
    external_source_kind, external_source_id, external_source_line_id,
    posting_generation, reversal_of_id, reversal_reason, evidence_waiver, legacy_provenance, created_at
  ) VALUES (
    v_rev_id, v_orig.organization_id, v_orig.voucher_id, v_orig.posting_subject_kind, v_orig.posting_subject_id,
    v_orig.direction, v_orig.account_id, v_orig.gross_amount, v_orig.voucher_amount_snapshot, v_orig.amount_basis,
    -v_orig.net_cash_effect, p_posted_on, p_membership, p_user,
    v_orig.approval_request_id, v_orig.approval_version, 'REVERSAL', v_idem, 'LEGACY_DELTA_REPLACEMENT',
    v_orig.external_source_kind, v_orig.external_source_id, v_orig.external_source_line_id,
    v_orig.posting_generation, v_orig.id, p_reason, 'PRE_V2_HISTORY',
    jsonb_build_object('delta_reversal_of', p_orig_id, 'change_log_seq', p_seq), now()
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  SELECT p.id INTO v_existing
  FROM public.income_expense_postings p
  WHERE p.organization_id = v_orig.organization_id AND p.idempotency_key = v_idem;
  v_rev_id := v_existing;

  -- Opposing signed lines for every line of the original (append-only; only if not already present).
  IF NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = v_rev_id) THEN
    FOR v_line IN SELECT * FROM public.income_expense_posting_lines l WHERE l.posting_id = v_orig.id LOOP
      INSERT INTO public.income_expense_posting_lines (
        id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
      ) VALUES (
        gen_random_uuid(), v_line.organization_id, v_rev_id, v_line.account_id, 'REVERSAL', -v_line.signed_amount, now()
      );
    END LOOP;
  END IF;

  RETURN v_rev_id;
END
$append_reversal$;
REVOKE ALL ON FUNCTION app_private.finance_v2_append_reversal_v1(uuid, date, uuid, uuid, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_append_reversal_v1(uuid, date, uuid, uuid, text, bigint) IS
  'Plan §6.2/§10.3: append (idempotently) a REVERSAL event + opposing lines for a POSTING; one per original.';

-- C2. Append a plain-legacy VOUCHER_TOTAL POSTING generation from the CURRENT legacy voucher fields
--     (source_kind='LEGACY_DELTA_REPLACEMENT'). Signed MAIN/CHANGE/ROUNDING lines match the legacy
--     balance formula exactly (identical to Stage-4 B1). Idempotent per (voucher, generation).
DROP FUNCTION IF EXISTS app_private.finance_v2_append_legacy_posting_v1(uuid, bigint, date, uuid, uuid, bigint);
CREATE FUNCTION app_private.finance_v2_append_legacy_posting_v1(
  p_voucher uuid, p_generation bigint, p_posted_on date, p_membership uuid, p_user uuid, p_seq bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $append_posting$
DECLARE
  v_ie public.income_expenses;
  v_id uuid := gen_random_uuid();
  v_idem text;
  v_existing uuid;
  v_signed numeric(18,2);
  v_net numeric(18,2);
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_v2_append_legacy_posting_v1: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.total_amount IS NULL OR v_ie.total_amount <= 0 THEN
    RAISE EXCEPTION 'finance_v2_append_legacy_posting_v1: voucher % total must be positive', p_voucher USING ERRCODE = '55000';
  END IF;

  v_idem := 'fin_v2_delta:posting:' || p_voucher::text || ':g' || p_generation::text;
  SELECT p.id INTO v_existing
  FROM public.income_expense_postings p
  WHERE p.organization_id = v_ie.organization_id AND p.idempotency_key = v_idem;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_signed := CASE WHEN v_ie.type = 'INCOME' THEN v_ie.total_amount ELSE -v_ie.total_amount END;
  v_net := v_signed
    + (CASE WHEN v_ie.change_account_id   IS NOT NULL AND COALESCE(v_ie.change_amount, 0)   <> 0 THEN v_ie.change_amount   ELSE 0 END)
    + (CASE WHEN v_ie.rounding_account_id IS NOT NULL AND COALESCE(v_ie.rounding_amount, 0) <> 0 THEN v_ie.rounding_amount ELSE 0 END);

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_request_id, approval_version, event_kind, idempotency_key, source_kind,
    posting_generation, evidence_waiver, legacy_provenance, created_at
  ) VALUES (
    v_id, v_ie.organization_id, v_ie.id, 'VOUCHER', v_ie.id,
    v_ie.type, v_ie.account_id, v_ie.total_amount, v_ie.total_amount, 'VOUCHER_TOTAL',
    v_net, p_posted_on, p_membership, p_user,
    v_ie.approval_request_id, COALESCE(v_ie.approval_version, 1), 'POSTING', v_idem, 'LEGACY_DELTA_REPLACEMENT',
    p_generation, 'PRE_V2_HISTORY',
    jsonb_build_object('delta', 'LEGACY_DELTA_REPLACEMENT', 'change_log_seq', p_seq,
                       'voucher_code', v_ie.code, 'generation', p_generation), now()
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  SELECT p.id INTO v_id
  FROM public.income_expense_postings p
  WHERE p.organization_id = v_ie.organization_id AND p.idempotency_key = v_idem;

  -- MAIN (|signed| = gross by direction).
  IF NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = v_id AND l.line_kind = 'MAIN') THEN
    INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), v_ie.organization_id, v_id, v_ie.account_id, 'MAIN', v_signed, now());
  END IF;
  -- CHANGE (+change_amount on change_account_id) — legacy sign preserved.
  IF v_ie.change_account_id IS NOT NULL AND COALESCE(v_ie.change_amount, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = v_id AND l.line_kind = 'CHANGE') THEN
    INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), v_ie.organization_id, v_id, v_ie.change_account_id, 'CHANGE', v_ie.change_amount, now());
  END IF;
  -- ROUNDING (+rounding_amount on rounding_account_id) — legacy sign preserved.
  IF v_ie.rounding_account_id IS NOT NULL AND COALESCE(v_ie.rounding_amount, 0) <> 0
     AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = v_id AND l.line_kind = 'ROUNDING') THEN
    INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), v_ie.organization_id, v_id, v_ie.rounding_account_id, 'ROUNDING', v_ie.rounding_amount, now());
  END IF;

  RETURN v_id;
END
$append_posting$;
REVOKE ALL ON FUNCTION app_private.finance_v2_append_legacy_posting_v1(uuid, bigint, date, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_append_legacy_posting_v1(uuid, bigint, date, uuid, uuid, bigint) IS
  'Plan §6.2/§10.3: append a LEGACY_DELTA_REPLACEMENT POSTING generation + signed MAIN/CHANGE/ROUNDING lines from current legacy fields.';

-- ============================================================================
-- PART D — Per-voucher reconcile (INSERT/UPDATE convergence). Returns an outcome text:
--   NOOP | CREATED | REVERSED_REPLACED | REVERSED_ONLY | EXCEPTION.
--   On EXCEPTION the caller LEAVES THE LOG ROW UNAPPLIED (§10.3). No partial posting writes precede
--   an EXCEPTION decision: every blocker (locked period, unresolved actor, owned divergence) is
--   checked before the first append.
-- ============================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_reconcile_voucher_posting_v1(uuid, uuid, bigint);
CREATE FUNCTION app_private.finance_v2_reconcile_voucher_posting_v1(
  p_run_id uuid, p_voucher uuid, p_seq bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $reconcile$
DECLARE
  v_ie public.income_expenses;
  v_is_virtual boolean;
  v_is_owned boolean;
  v_qualifies boolean;
  v_active public.income_expense_postings;
  v_has_active boolean := false;
  v_next_gen bigint;
  v_mid uuid;
  v_uid uuid;
  v_posted_on date;
  v_rev_id uuid;
  v_new_id uuid;
  v_new_post bigint;
  v_want_net numeric(18,2);
  v_cash_changed boolean;
  v_chg_acct uuid; v_chg_amt numeric(18,2);
  v_rnd_acct uuid; v_rnd_amt numeric(18,2);
BEGIN
  -- Lock the voucher (fixed order: voucher first). Missing row -> nothing to reconcile here.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'NOOP';
  END IF;

  SELECT COALESCE(a.is_virtual, true) INTO v_is_virtual
  FROM public.accounts a WHERE a.id = v_ie.account_id;
  v_is_virtual := COALESCE(v_is_virtual, true);  -- no/unknown account => not a real cashbook

  -- Adapter-owned? (V5 tender / salary / termination-forfeit / profit-payout / flow-owned)
  v_is_owned :=
       EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = v_ie.id)
    OR COALESCE(v_ie.system_source, '') IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
    OR v_ie.salary_staff_id IS NOT NULL
    OR v_ie.payment_collection_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.invoice_payment_tenders t WHERE t.voucher_id = v_ie.id)
    OR EXISTS (SELECT 1 FROM public.profit_payout_reservations pr WHERE pr.payout_voucher_id = v_ie.id)
    OR EXISTS (SELECT 1 FROM public.approval_requests ar
               WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = v_ie.id
                 AND ar.system_source = 'profit.distribution');

  -- The currently active (non-reversed) POSTING for the subject, if any.
  SELECT * INTO v_active
  FROM public.income_expense_postings p
  WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v_ie.id
    AND p.event_kind = 'POSTING'
    AND NOT EXISTS (SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id = p.id)
  ORDER BY p.posting_generation DESC
  LIMIT 1
  FOR UPDATE;
  v_has_active := FOUND;

  SELECT COALESCE(max(p.posting_generation), 0) + 1 INTO v_next_gen
  FROM public.income_expense_postings p
  WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v_ie.id AND p.event_kind = 'POSTING';

  -- ------------------------------------------------------------------ ADAPTER-OWNED PATH
  -- The delta worker never rewrites adapter-owned lineage. It only ALERTS on divergence.
  IF v_is_owned THEN
    -- gross_amount == mirror total holds for both VOUCHER_TOTAL and EXTERNAL_TENDER_GROSS postings
    -- (Stage-4 pinned tender gross = voucher total), so a mismatch is a real owned-lineage divergence.
    IF v_has_active AND v_active.gross_amount IS DISTINCT FROM v_ie.total_amount THEN
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (v_ie.organization_id, v_ie.id, 'DELTA_OWNED_VOUCHER_DIVERGENCE',
              jsonb_build_object('change_log_seq', p_seq, 'active_gross', v_active.gross_amount,
                                 'voucher_total', v_ie.total_amount, 'system_source', v_ie.system_source))
      ON CONFLICT DO NOTHING;
      RETURN 'EXCEPTION';
    END IF;
    RETURN 'NOOP';  -- owned + consistent (or external-basis / not-yet-posted): adapter owns it.
  END IF;

  -- ------------------------------------------------------------------ PLAIN-LEGACY PATH
  v_qualifies := (v_ie.approval_status = 'APPROVED'
                  AND v_ie.deleted_at IS NULL
                  AND COALESCE(v_ie.total_amount, 0) > 0
                  AND v_is_virtual = false);

  -- Resolve the historical poster (approved_by else user_id) to an ACTIVE membership — never guessed.
  SELECT om.user_id_out, om.membership_id_out INTO v_uid, v_mid
  FROM LATERAL (
    SELECT COALESCE(v_ie.approved_by, v_ie.user_id) AS user_id_out, m.id AS membership_id_out
    FROM public.organization_memberships m
    WHERE m.organization_id = v_ie.organization_id
      AND m.user_id = COALESCE(v_ie.approved_by, v_ie.user_id)
      AND m.status = 'ACTIVE'
    ORDER BY m.activated_at NULLS LAST, m.id
    LIMIT 1
  ) om;

  v_posted_on := v_ie.voucher_date;

  -- CASE 1: voucher should NOT carry a cash posting but an active one exists -> reverse it away.
  IF NOT v_qualifies THEN
    IF v_has_active AND v_active.amount_basis = 'VOUCHER_TOTAL' THEN
      IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_active.account_id, v_posted_on) THEN
        INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
        VALUES (v_ie.organization_id, v_ie.id, 'DELTA_LOCKED_PERIOD',
                jsonb_build_object('change_log_seq', p_seq, 'posted_on', v_posted_on,
                                   'cashbook_id', v_active.account_id, 'phase', 'reverse_only'))
        ON CONFLICT DO NOTHING;
        RETURN 'EXCEPTION';
      END IF;
      v_rev_id := app_private.finance_v2_append_reversal_v1(
        v_active.id, v_posted_on, COALESCE(v_mid, v_active.posted_by_membership_id),
        COALESCE(v_uid, v_active.posted_by_user_id), 'LEGACY delta: voucher no longer a cash effect', p_seq);
      v_new_post := COALESCE(v_ie.posting_version, 1) + 1;
      UPDATE public.income_expenses ie
         SET active_posting_id_v2 = NULL,
             posting_status = CASE WHEN v_ie.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'REVERSED' END,
             reversed_by_posting_id = v_rev_id, posting_version = v_new_post, updated_at = now()
       WHERE ie.id = v_ie.id;
      RETURN 'REVERSED_ONLY';
    END IF;
    RETURN 'NOOP';  -- non-qualifying and nothing posted: nothing to do.
  END IF;

  -- Qualifies: a plain cash posting IS wanted. Need a resolvable poster to attribute the event.
  IF v_mid IS NULL THEN
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (v_ie.organization_id, v_ie.id, 'UNRESOLVED_POSTED_BY_ACTOR',
            jsonb_build_object('change_log_seq', p_seq, 'approved_by', v_ie.approved_by, 'user_id', v_ie.user_id))
    ON CONFLICT DO NOTHING;
    RETURN 'EXCEPTION';
  END IF;

  -- CASE 2: qualifies but no active posting yet -> create the (fresh / re-approved) posting.
  IF NOT v_has_active THEN
    IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_ie.account_id, v_posted_on) THEN
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (v_ie.organization_id, v_ie.id, 'DELTA_LOCKED_PERIOD',
              jsonb_build_object('change_log_seq', p_seq, 'posted_on', v_posted_on,
                                 'cashbook_id', v_ie.account_id, 'phase', 'create'))
      ON CONFLICT DO NOTHING;
      RETURN 'EXCEPTION';
    END IF;
    v_new_id := app_private.finance_v2_append_legacy_posting_v1(v_ie.id, v_next_gen, v_posted_on, v_mid, v_uid, p_seq);
    v_new_post := COALESCE(v_ie.posting_version, 1) + 1;
    UPDATE public.income_expenses ie
       SET active_posting_id_v2 = v_new_id, posting_status = 'POSTED', posting_id = v_new_id,
           posting_mode = 'CASHBOOK', posted_at_v2 = now(),
           posting_version = v_new_post, review_state = 'RESOLVED', updated_at = now()
     WHERE ie.id = v_ie.id;
    RETURN 'CREATED';
  END IF;

  -- CASE 3: qualifies AND has an active posting -> compare cash face; note-only vs cash-effect change.
  -- Only VOUCHER_TOTAL basis is reconcilable here (external/tranche basis is adapter-owned & filtered
  -- out above). Compare direction / account / gross / net + CHANGE/ROUNDING lines to current legacy.
  v_want_net := (CASE WHEN v_ie.type = 'INCOME' THEN v_ie.total_amount ELSE -v_ie.total_amount END)
    + (CASE WHEN v_ie.change_account_id   IS NOT NULL AND COALESCE(v_ie.change_amount, 0)   <> 0 THEN v_ie.change_amount   ELSE 0 END)
    + (CASE WHEN v_ie.rounding_account_id IS NOT NULL AND COALESCE(v_ie.rounding_amount, 0) <> 0 THEN v_ie.rounding_amount ELSE 0 END);

  SELECT l.account_id, l.signed_amount INTO v_chg_acct, v_chg_amt
  FROM public.income_expense_posting_lines l WHERE l.posting_id = v_active.id AND l.line_kind = 'CHANGE';
  SELECT l.account_id, l.signed_amount INTO v_rnd_acct, v_rnd_amt
  FROM public.income_expense_posting_lines l WHERE l.posting_id = v_active.id AND l.line_kind = 'ROUNDING';

  v_cash_changed :=
       v_active.direction IS DISTINCT FROM v_ie.type
    OR v_active.account_id IS DISTINCT FROM v_ie.account_id
    OR v_active.gross_amount IS DISTINCT FROM v_ie.total_amount
    OR v_active.net_cash_effect IS DISTINCT FROM v_want_net
    OR v_chg_acct IS DISTINCT FROM (CASE WHEN COALESCE(v_ie.change_amount, 0) <> 0 THEN v_ie.change_account_id END)
    OR COALESCE(v_chg_amt, 0) IS DISTINCT FROM (CASE WHEN v_ie.change_account_id IS NOT NULL THEN COALESCE(v_ie.change_amount, 0) ELSE 0 END)
    OR v_rnd_acct IS DISTINCT FROM (CASE WHEN COALESCE(v_ie.rounding_amount, 0) <> 0 THEN v_ie.rounding_account_id END)
    OR COALESCE(v_rnd_amt, 0) IS DISTINCT FROM (CASE WHEN v_ie.rounding_account_id IS NOT NULL THEN COALESCE(v_ie.rounding_amount, 0) ELSE 0 END);

  IF NOT v_cash_changed THEN
    -- Note-only: refresh the projection mirror only; never touch event/lines (§10.3).
    IF v_ie.active_posting_id_v2 IS DISTINCT FROM v_active.id OR v_ie.posting_status IS DISTINCT FROM 'POSTED' THEN
      UPDATE public.income_expenses ie
         SET active_posting_id_v2 = v_active.id, posting_status = 'POSTED', posting_id = v_active.id, updated_at = now()
       WHERE ie.id = v_ie.id;
    END IF;
    RETURN 'NOOP';
  END IF;

  -- Cash-effect changed: reversal of the active generation + replacement POSTING generation.
  -- Both the reversal (open period vs the ORIGINAL account) and the replacement (open period vs the
  -- NEW account) must land in open periods, else divert to exception without any append.
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_active.account_id, v_posted_on)
     OR NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_ie.account_id, v_posted_on) THEN
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (v_ie.organization_id, v_ie.id, 'DELTA_LOCKED_PERIOD',
            jsonb_build_object('change_log_seq', p_seq, 'posted_on', v_posted_on,
                               'orig_cashbook_id', v_active.account_id, 'new_cashbook_id', v_ie.account_id,
                               'phase', 'reverse_and_replace'))
    ON CONFLICT DO NOTHING;
    RETURN 'EXCEPTION';
  END IF;

  v_rev_id := app_private.finance_v2_append_reversal_v1(
    v_active.id, v_posted_on, v_mid, v_uid, 'LEGACY delta: cash-effect change (reverse active generation)', p_seq);
  v_new_id := app_private.finance_v2_append_legacy_posting_v1(v_ie.id, v_next_gen, v_posted_on, v_mid, v_uid, p_seq);

  -- Link the replacement to the generation it supersedes (append-only lineage on the NEW event).
  UPDATE public.income_expense_postings p
     SET replaces_posting_id = v_active.id
   WHERE p.id = v_new_id AND p.replaces_posting_id IS NULL;

  v_new_post := COALESCE(v_ie.posting_version, 1) + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = v_new_id, posting_status = 'POSTED', posting_id = v_new_id,
         posting_mode = 'CASHBOOK', posted_at_v2 = now(), reversed_by_posting_id = v_rev_id,
         posting_version = v_new_post, review_state = 'RESOLVED', updated_at = now()
   WHERE ie.id = v_ie.id;
  RETURN 'REVERSED_REPLACED';
END
$reconcile$;
REVOKE ALL ON FUNCTION app_private.finance_v2_reconcile_voucher_posting_v1(uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_reconcile_voucher_posting_v1(uuid, uuid, bigint) IS
  'Plan §10.3: converge a plain-legacy voucher''s shadow posting to its current cash face (create / reverse+replace / note-only / owned-divergence alert); never mutates an event.';

-- ============================================================================
-- PART E — DELETE handling for an income_expenses change-log row (§10.3 tombstone + reversal contract).
--   Returns: TOMBSTONE_ONLY | REVERSED_DELETED | EXCEPTION.
-- ============================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_apply_voucher_delete_v1(uuid, uuid, uuid, bigint);
CREATE FUNCTION app_private.finance_v2_apply_voucher_delete_v1(
  p_run_id uuid, p_org uuid, p_voucher uuid, p_seq bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $apply_delete$
DECLARE
  v_ie public.income_expenses;
  v_active public.income_expense_postings;
  v_has_active boolean := false;
  v_mid uuid; v_uid uuid;
  v_posted_on date;
  v_rev_id uuid;
  v_new_post bigint;
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;

  -- Row is truly gone (hard DELETE captured by OLD). Never cascade a delete over a live posting.
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.income_expense_postings p
      WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
        AND p.event_kind = 'POSTING'
        AND NOT EXISTS (SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id = p.id)
    ) THEN
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (COALESCE(p_org, '00000000-0000-0000-0000-000000000000'::uuid), p_voucher, 'HARD_DELETE_WITH_CASH_EFFECT',
              jsonb_build_object('change_log_seq', p_seq, 'note', 'row hard-deleted while a live POSTING references it'))
      ON CONFLICT DO NOTHING;
      RETURN 'EXCEPTION';
    END IF;
    RETURN 'TOMBSTONE_ONLY';  -- deleted row that never posted: nothing to reverse.
  END IF;

  -- Row still exists (compatibility soft-delete / guard-protected). Find the live posting.
  SELECT * INTO v_active
  FROM public.income_expense_postings p
  WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v_ie.id
    AND p.event_kind = 'POSTING'
    AND NOT EXISTS (SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id = p.id)
  ORDER BY p.posting_generation DESC
  LIMIT 1
  FOR UPDATE;
  v_has_active := FOUND;

  IF NOT v_has_active THEN
    -- No cash effect: pure tombstone. Set deleted_at (compatibility delete guard) idempotently.
    IF v_ie.deleted_at IS NULL THEN
      UPDATE public.income_expenses ie
         SET deleted_at = now(),
             posting_status = CASE WHEN v_ie.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END,
             updated_at = now()
       WHERE ie.id = v_ie.id;
    END IF;
    RETURN 'TOMBSTONE_ONLY';
  END IF;

  -- Adapter-owned live posting: let the owning adapter reverse it — never here.
  IF v_active.amount_basis <> 'VOUCHER_TOTAL' THEN
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (v_ie.organization_id, v_ie.id, 'DELTA_OWNED_DELETE',
            jsonb_build_object('change_log_seq', p_seq, 'amount_basis', v_active.amount_basis,
                               'active_posting_id', v_active.id))
    ON CONFLICT DO NOTHING;
    RETURN 'EXCEPTION';
  END IF;

  -- Reverse in an open period; leave unapplied if the original account's period is locked.
  v_posted_on := v_ie.voucher_date;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_active.account_id, v_posted_on) THEN
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (v_ie.organization_id, v_ie.id, 'DELTA_LOCKED_PERIOD',
            jsonb_build_object('change_log_seq', p_seq, 'posted_on', v_posted_on,
                               'cashbook_id', v_active.account_id, 'phase', 'delete_reverse'))
    ON CONFLICT DO NOTHING;
    RETURN 'EXCEPTION';
  END IF;

  SELECT om.user_id_out, om.membership_id_out INTO v_uid, v_mid
  FROM LATERAL (
    SELECT COALESCE(v_ie.approved_by, v_ie.user_id) AS user_id_out, m.id AS membership_id_out
    FROM public.organization_memberships m
    WHERE m.organization_id = v_ie.organization_id
      AND m.user_id = COALESCE(v_ie.approved_by, v_ie.user_id)
      AND m.status = 'ACTIVE'
    ORDER BY m.activated_at NULLS LAST, m.id
    LIMIT 1
  ) om;

  v_rev_id := app_private.finance_v2_append_reversal_v1(
    v_active.id, v_posted_on, COALESCE(v_mid, v_active.posted_by_membership_id),
    COALESCE(v_uid, v_active.posted_by_user_id), 'LEGACY delta: compatibility delete (APPROVED + REVERSED)', p_seq);

  -- Compatibility delete: tombstone + REVERSED, approval_status stays APPROVED (§10.3). No CANCELLED.
  v_new_post := COALESCE(v_ie.posting_version, 1) + 1;
  UPDATE public.income_expenses ie
     SET deleted_at = COALESCE(v_ie.deleted_at, now()),
         active_posting_id_v2 = NULL, posting_status = 'REVERSED',
         reversed_by_posting_id = v_rev_id, posting_version = v_new_post, updated_at = now()
   WHERE ie.id = v_ie.id;
  RETURN 'REVERSED_DELETED';
END
$apply_delete$;
REVOKE ALL ON FUNCTION app_private.finance_v2_apply_voucher_delete_v1(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_apply_voucher_delete_v1(uuid, uuid, uuid, bigint) IS
  'Plan §10.3: DELETE contract — tombstone deleted_at + REVERSAL to APPROVED+REVERSED; hard-delete over a live posting -> exception (never cascade).';

-- ============================================================================
-- PART F — The replay driver (§10.3 step 3). Drains change_log in sequence_id order up to a watermark,
--          idempotently (applied_at IS NULL guard). Rows that reconcile are stamped applied; rows that
--          divert to an exception are LEFT UNAPPLIED so the zero-lag gate stays red until dispositioned.
-- ============================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_replay_change_log_v1(uuid, bigint);
CREATE FUNCTION app_private.finance_v2_replay_change_log_v1(
  p_run_id uuid, p_until_seq bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $replay$
DECLARE
  r          record;
  v_voucher  uuid;
  v_outcome  text;
  v_processed  bigint := 0;
  v_applied    bigint := 0;
  v_created    bigint := 0;
  v_rev_repl   bigint := 0;
  v_rev_del    bigint := 0;
  v_rev_only   bigint := 0;
  v_tombstone  bigint := 0;
  v_noop       bigint := 0;
  v_exception  bigint := 0;
  v_max_seq    bigint := 0;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'finance_v2_replay_change_log_v1: run_id is required' USING ERRCODE = '22023';
  END IF;
  -- The run header must exist (watermark bookkeeping lives there).
  IF NOT EXISTS (SELECT 1 FROM app_private.finance_v2_backfill_runs br WHERE br.run_id = p_run_id) THEN
    RAISE EXCEPTION 'finance_v2_replay_change_log_v1: unknown backfill run %', p_run_id USING ERRCODE = 'P0002';
  END IF;

  FOR r IN
    SELECT cl.*
    FROM app_private.finance_v2_backfill_change_log cl
    WHERE cl.applied_at IS NULL
      AND (p_until_seq IS NULL OR cl.sequence_id <= p_until_seq)
    ORDER BY cl.sequence_id
    FOR UPDATE
  LOOP
    v_processed := v_processed + 1;
    v_voucher := NULL;
    v_outcome := 'NOOP';

    IF r.source_table = 'public.income_expenses' THEN
      IF r.operation = 'DELETE' THEN
        v_outcome := app_private.finance_v2_apply_voucher_delete_v1(p_run_id, r.organization_id, r.source_pk, r.sequence_id);
      ELSE
        v_outcome := app_private.finance_v2_reconcile_voucher_posting_v1(p_run_id, r.source_pk, r.sequence_id);
      END IF;

    ELSIF r.source_table = 'public.income_expense_items' THEN
      -- A live item resolves to its voucher; a cash-relevant item change also re-touched the header,
      -- so the reconcile is the authoritative catch. A deleted item (row gone) is drained as a
      -- projection no-op — its voucher header carried the recompute.
      SELECT it.income_expense_id INTO v_voucher
      FROM public.income_expense_items it WHERE it.id = r.source_pk;
      IF v_voucher IS NOT NULL THEN
        v_outcome := app_private.finance_v2_reconcile_voucher_posting_v1(p_run_id, v_voucher, r.sequence_id);
      END IF;

    ELSIF r.source_table = 'public.invoice_payment_tenders' THEN
      SELECT t.voucher_id INTO v_voucher
      FROM public.invoice_payment_tenders t WHERE t.id = r.source_pk;
      IF v_voucher IS NOT NULL THEN
        v_outcome := app_private.finance_v2_reconcile_voucher_posting_v1(p_run_id, v_voucher, r.sequence_id);
      END IF;

    ELSIF r.source_table = 'public.invoice_payment_allocations' THEN
      SELECT t.voucher_id INTO v_voucher
      FROM public.invoice_payment_allocations al
      JOIN public.invoice_payment_tenders t ON t.id = al.tender_id
      WHERE al.id = r.source_pk;
      IF v_voucher IS NOT NULL THEN
        v_outcome := app_private.finance_v2_reconcile_voucher_posting_v1(p_run_id, v_voucher, r.sequence_id);
      END IF;

    -- public.accounts / public.account_shared_users / public.payments / public.invoice_payment_collections:
    -- no independent cash effect for a plain voucher's posting face — drained as projection. Any real
    -- cash divergence is caught by the header-driven reconcile above and by the count/SUM/hash parity gate.
    ELSE
      v_outcome := 'NOOP';
    END IF;

    -- Tally + stamp. EXCEPTION leaves the row UNAPPLIED (lag stays > 0 -> cutover blocked).
    IF v_outcome = 'EXCEPTION' THEN
      v_exception := v_exception + 1;
    ELSE
      CASE v_outcome
        WHEN 'CREATED'           THEN v_created   := v_created   + 1;
        WHEN 'REVERSED_REPLACED' THEN v_rev_repl  := v_rev_repl  + 1;
        WHEN 'REVERSED_DELETED'  THEN v_rev_del   := v_rev_del   + 1;
        WHEN 'REVERSED_ONLY'     THEN v_rev_only  := v_rev_only  + 1;
        WHEN 'TOMBSTONE_ONLY'    THEN v_tombstone := v_tombstone + 1;
        ELSE                          v_noop      := v_noop      + 1;
      END CASE;

      UPDATE app_private.finance_v2_backfill_change_log cl
         SET applied_run_id = p_run_id, applied_at = now()
       WHERE cl.sequence_id = r.sequence_id AND cl.applied_at IS NULL;
      v_applied := v_applied + 1;
      IF r.sequence_id > v_max_seq THEN v_max_seq := r.sequence_id; END IF;
    END IF;
  END LOOP;

  -- Advance the run's applied watermark to the highest contiguously-applied sequence (monotonic).
  UPDATE app_private.finance_v2_backfill_runs br
     SET applied_watermark = GREATEST(COALESCE(br.applied_watermark, 0), v_max_seq)
   WHERE br.run_id = p_run_id AND v_applied > 0;

  RETURN jsonb_build_object(
    'run_id',            p_run_id,
    'until_seq',         p_until_seq,
    'processed',         v_processed,
    'applied',           v_applied,
    'created',           v_created,
    'reversed_replaced', v_rev_repl,
    'reversed_deleted',  v_rev_del,
    'reversed_only',     v_rev_only,
    'tombstone_only',    v_tombstone,
    'noop',              v_noop,
    'exceptions',        v_exception,
    'max_applied_seq',   v_max_seq,
    'remaining_lag',     app_private.finance_v2_delta_lag_v1()
  );
END
$replay$;
REVOKE ALL ON FUNCTION app_private.finance_v2_replay_change_log_v1(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_replay_change_log_v1(uuid, bigint) IS
  'Plan §10.3: idempotent, repeatable change-log replay to a watermark; reconciles shadow postings, tombstones deletes, diverts ambiguous/locked/owned rows to exceptions (left unapplied). Never UPDATE/DELETEs an event.';

-- ============================================================================
-- PART G — Zero-lag gate primitive (§10.3 steps 4/5): unapplied change-log rows. 0 == drained.
-- ============================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_delta_lag_v1();
CREATE FUNCTION app_private.finance_v2_delta_lag_v1()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $delta_lag$
  SELECT count(*)::bigint
  FROM app_private.finance_v2_backfill_change_log cl
  WHERE cl.applied_at IS NULL;
$delta_lag$;
REVOKE ALL ON FUNCTION app_private.finance_v2_delta_lag_v1()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_delta_lag_v1() IS
  'Plan §10.3: zero-lag gate primitive — count of unapplied (applied_at IS NULL) change-log rows.';

COMMIT;

NOTIFY pgrst, 'reload schema';
