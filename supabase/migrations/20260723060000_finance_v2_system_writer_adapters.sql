-- Finance V2 (Thu Chi V2) — Stage 6: system-writer adapters (plan §7.1/§8/§8.1).
-- Flow-owner decision dispatcher + private adapters that WRAP (never rewrite) the landed
-- V5 / customer-credit / termination / contract / salary / profit invariants. Commission &
-- salary adapters are policy-gated (§2.6) and RAISE until a business-policy decision exists.
-- No feature mode changed, no org enrolled.

BEGIN;

-- Finance V2 (Thu Chi V2) — Stage 6: SYSTEM-WRITER ADAPTERS (plan §7.1 adapters, §8, §8.1).
-- BODY ONLY (orchestrator wraps in one txn; NO BEGIN/COMMIT/NOTIFY). Idempotent.
-- Registers the flow-owner decision dispatcher + private adapters that WRAP (never
-- rewrite) the landed V5 / customer-credit / termination / contract / salary / profit
-- invariants. No feature mode changed, no org enrolled. Compile-clean against Stage 1-5.

-- =====================================================================
-- §8 PART 0 — flow-owner -> adapter registry (fail-closed lookup).
-- =====================================================================
CREATE TABLE IF NOT EXISTS app_private.finance_flow_owner_adapters (
  flow_owner          text PRIMARY KEY,
  adapter_name        text NOT NULL,
  is_system_owned     boolean NOT NULL DEFAULT true,
  decision_scope      text NOT NULL DEFAULT 'SUBJECT'
                        CHECK (decision_scope IN ('SUBJECT','PAIR','BUNDLE','RESERVATION','MANUAL')),
  requires_policy_key text NULL,                         -- §2.6 policy gate (NULL = none)
  supported_decisions text[] NOT NULL DEFAULT ARRAY[]::text[],
  note                text
);
REVOKE ALL ON app_private.finance_flow_owner_adapters FROM PUBLIC;
DO $adp_acl$
BEGIN
  IF to_regrole('anon')          IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_flow_owner_adapters FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_flow_owner_adapters FROM authenticated'; END IF;
  IF to_regrole('service_role')  IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_flow_owner_adapters FROM service_role'; END IF;
END
$adp_acl$;
COMMENT ON TABLE app_private.finance_flow_owner_adapters IS
  'Plan §8: flow-owner -> private lifecycle/post/reverse adapter registry. Unknown owner = fail closed (no manual fallback).';

-- Seed the minimum registry (plan §8 line 881). MANUAL is the only non-system owner
-- and routes to the Stage-5 canonical manual primitives (no ownership row => MANUAL).
INSERT INTO app_private.finance_flow_owner_adapters
  (flow_owner, adapter_name, is_system_owned, decision_scope, requires_policy_key, supported_decisions, note)
VALUES
  ('MANUAL', 'CANONICAL_INCOME_EXPENSE', false, 'MANUAL', NULL,
   ARRAY['approve','request_changes','reject','dispute','cancel','resubmit','post','approve_and_post','reverse'],
   'No ownership row: served by Stage-5 public manual RPCs directly.'),
  ('CANONICAL_INCOME_EXPENSE', 'CANONICAL_INCOME_EXPENSE', false, 'MANUAL', NULL,
   ARRAY['approve','request_changes','reject','dispute','cancel','resubmit','post','approve_and_post','reverse'],
   'Explicit canonical manual owner alias.'),
  ('INVOICE_REFUND', 'INVOICE_REFUND', true, 'RESERVATION', NULL,
   ARRAY['approve','reject','cancel','post','reverse'],
   'reserve_invoice_refund_obligation_v2 / transition_invoice_refund_reservation_v2.'),
  ('TERMINATION_REFUND', 'INVOICE_REFUND', true, 'RESERVATION', NULL,
   ARRAY['approve','reject','cancel','post','reverse'],
   'Termination-originated refund obligation; same refund reservation adapter, system_source termination.refund.'),
  ('CONTRACT_COMMISSION_STANDALONE', 'SALARY_BUNDLE', true, 'BUNDLE', 'contract.commission.settlement.v2',
   ARRAY['approve','reject','resubmit','cancel','post','reverse'],
   'STANDALONE commission voucher; §2.6 policy decision required before activation.'),
  ('SALARY_BUNDLE', 'SALARY_BUNDLE', true, 'BUNDLE', 'salary.settlement.v2',
   ARRAY['approve','reject','resubmit','cancel','post','reverse'],
   'transition_salary_settlement_bundle_v2 / post_salary_settlement_tranche_v2.'),
  ('PROFIT_PAYOUT', 'PROFIT_PAYOUT', true, 'RESERVATION', NULL,
   ARRAY['approve','cancel','post','reverse'],
   'transition_profit_payout_reservation_v2 (HELD/CONSUMED/RELEASED/REVERSED).'),
  ('UTILITY_RECURRING', 'CANONICAL_INCOME_EXPENSE', true, 'SUBJECT', NULL,
   ARRAY['approve','request_changes','reject','cancel','post','reverse'],
   'Recurring/utility obligation: pending recognized; period job never auto-approves. Voucher lifecycle path.'),
  ('TERMINATION_FORFEIT_PAIR_V2', 'TERMINATION_FORFEIT_PAIR', true, 'PAIR', NULL,
   ARRAY['approve','cancel','reverse'],
   'transition_termination_forfeit_pair_v2 — one request per pair, generic per-leg blocked.'),
  ('TERMINATION_MOVE_OUT_PAIR', 'TERMINATION_MOVE_OUT_PAIR', true, 'PAIR', NULL,
   ARRAY['approve','cancel','reverse'],
   'transition_termination_move_out_pair_v2 / reverse_termination_move_out_pair_v2.')
ON CONFLICT (flow_owner) DO UPDATE
  SET adapter_name = EXCLUDED.adapter_name,
      is_system_owned = EXCLUDED.is_system_owned,
      decision_scope = EXCLUDED.decision_scope,
      requires_policy_key = EXCLUDED.requires_policy_key,
      supported_decisions = EXCLUDED.supported_decisions,
      note = EXCLUDED.note;

-- =====================================================================
-- §8.1 PART 1 — durable state tables owned by Stage-6 adapters.
-- =====================================================================

-- Invoice-refund reservation ledger (HELD/CONSUMED/RELEASED/REVERSED). Approve-only
-- never mutates refunded_cash/invoice paid; post/reverse consume/release here.
CREATE TABLE IF NOT EXISTS app_private.invoice_refund_reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  refund_voucher_id   uuid NOT NULL,
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  refund_class        text NOT NULL
                        CHECK (refund_class IN ('DEPOSIT','CUSTOMER_CREDIT','REFUND_CONTRA_REVENUE')),
  reservation_state   text NOT NULL DEFAULT 'HELD'
                        CHECK (reservation_state IN ('HELD','CONSUMED','RELEASED','REVERSED')),
  state_version       bigint NOT NULL DEFAULT 1,
  consumed_posting_id uuid,
  reversed_posting_id uuid,
  idempotency_key     text NOT NULL,
  source_payload_hash text,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  state_changed_at    timestamptz,
  state_reason        text,
  CONSTRAINT invoice_refund_reservations_org_idem_uq UNIQUE (organization_id, idempotency_key),
  CONSTRAINT invoice_refund_reservations_voucher_uq   UNIQUE (organization_id, refund_voucher_id)
);
CREATE INDEX IF NOT EXISTS invoice_refund_reservations_invoice_live_idx
  ON app_private.invoice_refund_reservations (organization_id, invoice_id)
  WHERE reservation_state IN ('HELD','CONSUMED');
REVOKE ALL ON app_private.invoice_refund_reservations FROM PUBLIC;
DO $irr_acl$
BEGIN
  IF to_regrole('anon')          IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.invoice_refund_reservations FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.invoice_refund_reservations FROM authenticated'; END IF;
  IF to_regrole('service_role')  IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.invoice_refund_reservations FROM service_role'; END IF;
END
$irr_acl$;
COMMENT ON TABLE app_private.invoice_refund_reservations IS
  'Plan §8.1 invoice refund: HELD/CONSUMED counts against refundable due; DEPOSIT/CUSTOMER_CREDIT = no P&L, REFUND_CONTRA_REVENUE = negative P&L that blocks close while pending.';

-- Deferred customer-credit remediation queue (wrapper deferred=true). NOT applied/refunded;
-- resolver operation/idempotency namespace is separate from apply/refund writers.
CREATE TABLE IF NOT EXISTS app_private.deferred_customer_credit_queue (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  source_kind         text NOT NULL,                    -- e.g. TERMINATION_FORFEIT
  source_id           uuid NOT NULL,                    -- contract/termination id
  customer_id         uuid,
  invoice_id          uuid,
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  queue_state         text NOT NULL DEFAULT 'PENDING'
                        CHECK (queue_state IN ('PENDING','RESOLVED_APPLIED','RESOLVED_REFUND_OBLIGATION','CANCELLED')),
  resolver_operation  text,                             -- separate namespace from apply/refund idempotency
  resolver_ref_id     uuid,
  wrapper_idempotency_key text NOT NULL,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT deferred_customer_credit_queue_key UNIQUE (organization_id, source_kind, source_id, wrapper_idempotency_key)
);
REVOKE ALL ON app_private.deferred_customer_credit_queue FROM PUBLIC;
DO $dcq_acl$
BEGIN
  IF to_regrole('anon')          IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.deferred_customer_credit_queue FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.deferred_customer_credit_queue FROM authenticated'; END IF;
  IF to_regrole('service_role')  IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.deferred_customer_credit_queue FROM service_role'; END IF;
END
$dcq_acl$;
COMMENT ON TABLE app_private.deferred_customer_credit_queue IS
  'Plan §8.1: durable remediation queue for wrapper deferred customer credit; a PENDING row is NOT applied/refunded truth.';

-- =====================================================================
-- §7.1 PART 2 — owned-header transition helper (ie_transition_authorization token).
-- The a00_ie_owned_payload_freeze / forfeit / profit guards freeze flow-owned voucher
-- headers against generic writers; the owning-adapter path presents a per-xid token.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_stamp_owned_posting_state(uuid, text, uuid, text, text, date);
CREATE FUNCTION app_private.finance_v2_stamp_owned_posting_state(
  p_voucher uuid, p_posting_status text, p_active_posting_id uuid,
  p_review_state text, p_recognition_source_mode text, p_recognition_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $stamp_owned$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'finance_v2.owned_posting_stamp')
  ON CONFLICT DO NOTHING;

  UPDATE public.income_expenses ie
     SET posting_status          = COALESCE(p_posting_status, ie.posting_status),
         active_posting_id_v2    = CASE WHEN p_posting_status = 'POSTED' THEN p_active_posting_id
                                        WHEN p_posting_status = 'REVERSED' THEN NULL
                                        ELSE ie.active_posting_id_v2 END,
         review_state            = COALESCE(p_review_state, ie.review_state),
         recognition_source_mode = COALESCE(p_recognition_source_mode, ie.recognition_source_mode),
         recognition_date        = COALESCE(p_recognition_date, ie.recognition_date),
         posting_version         = ie.posting_version + 1,
         updated_at              = now()
   WHERE ie.id = p_voucher;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM app_private.ie_transition_authorization t
   WHERE t.income_expense_id = p_voucher AND t.xid = pg_current_xact_id();

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'finance_v2_stamp_owned_posting_state: expected 1 row, affected % for voucher %', v_rows, p_voucher
      USING ERRCODE = '55000';
  END IF;
END
$stamp_owned$;
REVOKE ALL ON FUNCTION app_private.finance_v2_stamp_owned_posting_state(uuid, text, uuid, text, text, date)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_stamp_owned_posting_state(uuid, text, uuid, text, text, date) IS
  'Plan §7.1: owning-adapter path to stamp a flow-owned voucher posting_status/active pointer using the per-xid ie_transition_authorization token.';

-- Owned approval-status transition (APPROVED/CANCELLED) for system pair/refund legs, token-guarded.
DROP FUNCTION IF EXISTS app_private.finance_v2_transition_owned_approval(uuid, text, text);
CREATE FUNCTION app_private.finance_v2_transition_owned_approval(
  p_voucher uuid, p_new_status text, p_posting_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $trans_owned$
DECLARE
  v_rows integer;
BEGIN
  IF p_new_status NOT IN ('APPROVED','CANCELLED') THEN
    RAISE EXCEPTION 'finance_v2_transition_owned_approval: unsupported status %', p_new_status USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), p_new_status)
  ON CONFLICT DO NOTHING;

  UPDATE public.income_expenses ie
     SET approval_status = p_new_status,
         approved_at     = CASE WHEN p_new_status = 'APPROVED' THEN now() ELSE ie.approved_at END,
         review_state    = 'RESOLVED',
         posting_status  = COALESCE(p_posting_status, ie.posting_status),
         approval_version = ie.approval_version + 1,
         updated_at      = now()
   WHERE ie.id = p_voucher;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM app_private.ie_transition_authorization t
   WHERE t.income_expense_id = p_voucher AND t.xid = pg_current_xact_id();

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'finance_v2_transition_owned_approval: expected 1 row, affected % for voucher %', v_rows, p_voucher
      USING ERRCODE = '55000';
  END IF;
END
$trans_owned$;
REVOKE ALL ON FUNCTION app_private.finance_v2_transition_owned_approval(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_transition_owned_approval(uuid, text, text) IS
  'Plan §7.1: owning-adapter path to approve/cancel a flow-owned system leg (no cash posting), token-guarded.';

-- =====================================================================
-- §7.1 PART 3 — register_system_evidence_v2 (SYSTEM_REFERENCE from a typed source).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.register_system_evidence_v2(uuid, text, uuid, uuid, uuid, text);
CREATE FUNCTION app_private.register_system_evidence_v2(
  p_org uuid, p_source_kind text, p_collection_id uuid, p_tender_id uuid,
  p_payment_id uuid, p_source_snapshot_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $reg_ev$
DECLARE
  v_bucket text := 'system-reference';
  v_object text;
  v_evidence uuid;
BEGIN
  IF p_source_kind NOT IN ('INVOICE_COLLECTION_V5','CONTRACT_V2','UTILITY','OTHER_ALLOWLISTED') THEN
    RAISE EXCEPTION 'register_system_evidence_v2: source_kind % not allow-listed', p_source_kind USING ERRCODE = '22023';
  END IF;

  -- Deterministic per-tender identity (plan §480: one SYSTEM_REFERENCE evidence per V5 tender).
  IF p_source_kind = 'INVOICE_COLLECTION_V5' THEN
    IF p_collection_id IS NULL OR p_tender_id IS NULL THEN
      RAISE EXCEPTION 'register_system_evidence_v2: collection_id + tender_id required for INVOICE_COLLECTION_V5' USING ERRCODE = '22023';
    END IF;
    -- Idempotent replay: return the existing evidence for this tender if already registered.
    SELECT s.evidence_id INTO v_evidence
    FROM public.finance_evidence_system_sources s
    WHERE s.organization_id = p_org AND s.source_kind = 'INVOICE_COLLECTION_V5'
      AND s.collection_id = p_collection_id AND s.tender_id = p_tender_id
    FOR UPDATE;
    IF v_evidence IS NOT NULL THEN
      RETURN v_evidence;
    END IF;
  END IF;

  v_object := p_source_kind || ':' || COALESCE(p_collection_id::text, '-') || ':'
              || COALESCE(p_tender_id::text, p_payment_id::text, '-');

  -- FINALIZED SYSTEM_REFERENCE object; NO raw URL from client. Reuse a stale identity idempotently.
  INSERT INTO public.finance_evidence_objects (
    id, organization_id, bucket_id, object_name, provenance_kind, state, sha256, finalized_at, created_at
  ) VALUES (
    gen_random_uuid(), p_org, v_bucket, v_object, 'SYSTEM_REFERENCE', 'FINALIZED', p_source_snapshot_hash, now(), now()
  )
  ON CONFLICT (organization_id, bucket_id, object_name) DO UPDATE
    SET state = 'FINALIZED', finalized_at = COALESCE(public.finance_evidence_objects.finalized_at, now())
  RETURNING id INTO v_evidence;

  INSERT INTO public.finance_evidence_system_sources (
    id, evidence_id, organization_id, source_kind, collection_id, tender_id, payment_id, source_snapshot_hash, created_at
  ) VALUES (
    gen_random_uuid(), v_evidence, p_org, p_source_kind, p_collection_id, p_tender_id, p_payment_id, p_source_snapshot_hash, now()
  )
  ON CONFLICT DO NOTHING;

  RETURN v_evidence;
END
$reg_ev$;
REVOKE ALL ON FUNCTION app_private.register_system_evidence_v2(uuid, text, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.register_system_evidence_v2(uuid, text, uuid, uuid, uuid, text) IS
  'Plan §6.3/§474/§480: FINALIZED SYSTEM_REFERENCE evidence from a typed source (no raw URL); deterministic per V5 tender.';

-- =====================================================================
-- §7.1 PART 4 — V5 tender posting adapters (WRAP record/reverse_invoice_collection_v5).
-- One posting lineage + one SYSTEM_REFERENCE evidence per tender, in the SAME V5 txn.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.post_collection_tender_v2(uuid, uuid, uuid);
CREATE FUNCTION app_private.post_collection_tender_v2(
  p_org uuid, p_collection_id uuid, p_tender_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $post_tender$
DECLARE
  v_t public.invoice_payment_tenders;
  v_ie public.income_expenses;
  v_coll_date date;
  v_posting_id uuid;
  v_signed numeric(18,2);
  v_evidence uuid;
  v_mid uuid;
BEGIN
  SELECT * INTO v_t FROM public.invoice_payment_tenders t
   WHERE t.id = p_tender_id AND t.organization_id = p_org AND t.collection_id = p_collection_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_collection_tender_v2: tender % not found in collection %', p_tender_id, p_collection_id USING ERRCODE = 'P0002';
  END IF;
  IF v_t.voucher_id IS NULL THEN
    RAISE EXCEPTION 'post_collection_tender_v2: tender % has no mirror voucher yet', p_tender_id USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = v_t.voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_collection_tender_v2: mirror voucher % missing', v_t.voucher_id USING ERRCODE = 'P0002';
  END IF;

  SELECT c.collection_date INTO v_coll_date FROM public.invoice_payment_collections c WHERE c.id = p_collection_id;
  v_coll_date := COALESCE(v_coll_date, v_ie.voucher_date);

  -- Idempotent replay: one lineage per (org, COLLECTION_V5, collection, tender, POSTING).
  SELECT p.id INTO v_posting_id
  FROM public.income_expense_postings p
  WHERE p.organization_id = p_org AND p.external_source_kind = 'COLLECTION_V5'
    AND p.external_source_id = p_collection_id AND p.external_source_line_id = p_tender_id
    AND p.event_kind = 'POSTING';
  IF v_posting_id IS NOT NULL THEN
    RETURN v_posting_id;
  END IF;

  SELECT om.id INTO v_mid
  FROM public.organization_memberships om
  WHERE om.organization_id = p_org AND om.user_id = COALESCE(v_ie.approved_by, v_ie.user_id) AND om.status = 'ACTIVE'
  ORDER BY om.activated_at NULLS LAST, om.id LIMIT 1;

  v_posting_id := gen_random_uuid();
  v_signed := CASE WHEN v_ie.type = 'INCOME' THEN v_t.gross_amount ELSE -v_t.gross_amount END;

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind,
    external_source_kind, external_source_id, external_source_line_id, posting_generation, created_at
  ) VALUES (
    v_posting_id, p_org, v_ie.id, 'VOUCHER', v_ie.id,
    v_ie.type, v_t.account_id, v_t.gross_amount, v_t.retained_amount, 'EXTERNAL_TENDER_GROSS',
    v_signed
      + CASE WHEN v_ie.change_account_id IS NOT NULL AND COALESCE(v_ie.change_amount,0) <> 0 THEN v_ie.change_amount ELSE 0 END
      + CASE WHEN v_ie.rounding_account_id IS NOT NULL AND COALESCE(v_ie.rounding_amount,0) <> 0 THEN v_ie.rounding_amount ELSE 0 END,
    v_coll_date, COALESCE(v_mid, v_ie.maker_membership_id), COALESCE(v_ie.approved_by, v_ie.user_id),
    COALESCE(v_ie.approval_version, 1), 'POSTING', 'fin_v2:v5:' || p_collection_id::text || ':' || p_tender_id::text,
    'COLLECTION_V5_ADAPTER', 'COLLECTION_V5', p_collection_id, p_tender_id, 1, now()
  );

  INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
  VALUES (gen_random_uuid(), p_org, v_posting_id, v_t.account_id, 'MAIN', v_signed, now());
  IF v_ie.change_account_id IS NOT NULL AND COALESCE(v_ie.change_amount,0) <> 0 THEN
    INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), p_org, v_posting_id, v_ie.change_account_id, 'CHANGE', v_ie.change_amount, now());
  END IF;
  IF v_ie.rounding_account_id IS NOT NULL AND COALESCE(v_ie.rounding_amount,0) <> 0 THEN
    INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), p_org, v_posting_id, v_ie.rounding_account_id, 'ROUNDING', v_ie.rounding_amount, now());
  END IF;

  -- SYSTEM_REFERENCE evidence from the immutable tender/collection lineage + attach.
  v_evidence := app_private.register_system_evidence_v2(
    p_org, 'INVOICE_COLLECTION_V5', p_collection_id, p_tender_id, v_t.payment_id,
    md5(coalesce(v_t.gross_amount::text,'') || ':' || coalesce(v_t.retained_amount::text,'') || ':' || p_tender_id::text));
  INSERT INTO public.income_expense_posting_evidence (id, organization_id, posting_id, evidence_id, relation_kind, created_at)
  VALUES (gen_random_uuid(), p_org, v_posting_id, v_evidence, 'ORIGINAL', now())
  ON CONFLICT DO NOTHING;

  -- Stamp the flow-owned header POSTED via the token path (V5 flow ownership already set by record_invoice_collection_v5).
  PERFORM app_private.finance_v2_stamp_owned_posting_state(v_ie.id, 'POSTED', v_posting_id, 'RESOLVED', NULL, NULL);

  RETURN v_posting_id;
END
$post_tender$;
REVOKE ALL ON FUNCTION app_private.post_collection_tender_v2(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.post_collection_tender_v2(uuid, uuid, uuid) IS
  'Plan §7.1/§8: one EXTERNAL_TENDER_GROSS posting lineage + SYSTEM_REFERENCE evidence per V5 tender, in the same V5 txn. Wraps record_invoice_collection_v5.';

DROP FUNCTION IF EXISTS app_private.reverse_collection_tender_v2(uuid, uuid, uuid, date, text);
CREATE FUNCTION app_private.reverse_collection_tender_v2(
  p_org uuid, p_collection_id uuid, p_tender_id uuid, p_reversal_date date, p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $rev_tender$
DECLARE
  v_orig public.income_expense_postings;
  v_rev_id uuid;
  v_mid uuid;
BEGIN
  SELECT * INTO v_orig FROM public.income_expense_postings p
   WHERE p.organization_id = p_org AND p.external_source_kind = 'COLLECTION_V5'
     AND p.external_source_id = p_collection_id AND p.external_source_line_id = p_tender_id
     AND p.event_kind = 'POSTING'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_collection_tender_v2: no original tender posting for collection %/tender %', p_collection_id, p_tender_id USING ERRCODE = 'P0002';
  END IF;

  SELECT p.id INTO v_rev_id FROM public.income_expense_postings p
   WHERE p.organization_id = p_org AND p.external_source_kind = 'COLLECTION_V5'
     AND p.external_source_id = p_collection_id AND p.external_source_line_id = p_tender_id
     AND p.event_kind = 'REVERSAL';
  IF v_rev_id IS NOT NULL THEN
    RETURN v_rev_id;
  END IF;

  SELECT om.id INTO v_mid FROM public.organization_memberships om
   WHERE om.organization_id = p_org AND om.status = 'ACTIVE'
   ORDER BY om.activated_at NULLS LAST, om.id LIMIT 1;

  v_rev_id := gen_random_uuid();
  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind,
    external_source_kind, external_source_id, external_source_line_id, posting_generation,
    reversal_of_id, reversal_reason, created_at
  ) VALUES (
    v_rev_id, p_org, v_orig.voucher_id, v_orig.posting_subject_kind, v_orig.posting_subject_id,
    v_orig.direction, v_orig.account_id, v_orig.gross_amount, v_orig.voucher_amount_snapshot, 'EXTERNAL_TENDER_GROSS',
    -v_orig.net_cash_effect, COALESCE(p_reversal_date, v_orig.posted_on), COALESCE(v_mid, v_orig.posted_by_membership_id), v_orig.posted_by_user_id,
    v_orig.approval_version, 'REVERSAL', 'fin_v2:v5rev:' || p_collection_id::text || ':' || p_tender_id::text,
    'COLLECTION_V5_ADAPTER', 'COLLECTION_V5', p_collection_id, p_tender_id, v_orig.posting_generation,
    v_orig.id, COALESCE(p_reason, 'V5 collection reversal'), now()
  );
  INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
  VALUES (gen_random_uuid(), p_org, v_rev_id, v_orig.account_id, 'REVERSAL', -v_orig.net_cash_effect, now());

  IF v_orig.voucher_id IS NOT NULL THEN
    PERFORM app_private.finance_v2_stamp_owned_posting_state(v_orig.voucher_id, 'REVERSED', NULL, NULL, NULL, NULL);
  END IF;
  RETURN v_rev_id;
END
$rev_tender$;
REVOKE ALL ON FUNCTION app_private.reverse_collection_tender_v2(uuid, uuid, uuid, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.reverse_collection_tender_v2(uuid, uuid, uuid, date, text) IS
  'Plan §7.1/§8: REVERSAL event linking the original tender posting (reversal_of_id); wraps reverse_invoice_collection_v5.';

-- =====================================================================
-- §8.1 PART 5 — invoice refund obligation reserve + reservation transition.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.reserve_invoice_refund_obligation_v2(uuid, uuid, uuid, numeric, text, text, uuid, uuid, text);
CREATE FUNCTION app_private.reserve_invoice_refund_obligation_v2(
  p_org uuid, p_invoice_id uuid, p_building_id uuid, p_amount numeric, p_refund_class text,
  p_system_source text, p_actor_user uuid, p_actor_membership uuid, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $reserve_refund$
DECLARE
  v_inv public.invoices;
  v_refundable numeric(18,2);
  v_live numeric(18,2);
  v_voucher uuid := gen_random_uuid();
  v_birth_op uuid := gen_random_uuid();
  v_hash text := md5(jsonb_build_object('i', p_invoice_id, 'a', p_amount, 'c', p_refund_class, 'k', p_idempotency_key)::text);
  v_counts boolean;
  v_kqkd numeric(18,2);
  v_existing app_private.invoice_refund_reservations;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_refund_class NOT IN ('DEPOSIT','CUSTOMER_CREDIT','REFUND_CONTRA_REVENUE') THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: invalid refund_class %', p_refund_class USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: idempotency key required' USING ERRCODE = '22023';
  END IF;

  -- Idempotent replay.
  SELECT * INTO v_existing FROM app_private.invoice_refund_reservations r
   WHERE r.organization_id = p_org AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('reservationId', v_existing.id, 'refundVoucherId', v_existing.refund_voucher_id,
                              'reservationState', v_existing.reservation_state, 'stateVersion', v_existing.state_version,
                              'replayed', true);
  END IF;

  -- Lock the invoice + refundable cap (paid_amount less already-live reservations).
  SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice_id AND i.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: invoice % not found', p_invoice_id USING ERRCODE = 'P0002';
  END IF;
  v_refundable := COALESCE(v_inv.paid_amount, 0);

  SELECT COALESCE(sum(r.amount), 0) INTO v_live
  FROM app_private.invoice_refund_reservations r
  WHERE r.organization_id = p_org AND r.invoice_id = p_invoice_id
    AND r.reservation_state IN ('HELD','CONSUMED');

  IF v_live + p_amount > v_refundable THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: refund % exceeds refundable due (live % + new % > paid %)',
      p_amount, v_live, p_amount, v_refundable USING ERRCODE = '55000';
  END IF;

  -- Classification: DEPOSIT/CUSTOMER_CREDIT = no P&L; contra-revenue = negative P&L (blocks close while pending).
  IF p_refund_class = 'REFUND_CONTRA_REVENUE' THEN
    v_counts := true;  v_kqkd := -p_amount;
  ELSE
    v_counts := false; v_kqkd := 0;
  END IF;

  -- Birth ONE pending obligation voucher (UNAPPROVED + UNPOSTED, no cashbook/posting/evidence at source).
  INSERT INTO public.income_expenses (
    id, user_id, type, name, building_id, invoice_id, voucher_date, total_amount,
    approval_status, organization_id, account_id, system_source,
    posting_mode, posting_status, review_state, review_version, approval_version, posting_version,
    maker_user_id, maker_membership_id, birth_operation_id, birth_txid, source_payload_hash,
    counts_in_business_result, kqkd_amount, recognition_date, recognition_source_mode, business_result_accounting
  ) VALUES (
    v_voucher, p_actor_user, 'EXPENSE', 'Hoàn tiền hóa đơn', p_building_id, p_invoice_id, CURRENT_DATE, p_amount,
    'UNAPPROVED', p_org, NULL, COALESCE(p_system_source, 'invoice.refund'),
    'CASHBOOK', 'UNPOSTED', 'PENDING', 1, 1, 1,
    p_actor_user, p_actor_membership, v_birth_op, pg_current_xact_id(), v_hash,
    v_counts, v_kqkd, CURRENT_DATE, 'BASE', v_counts
  );

  INSERT INTO app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, flow_kind, flow_version, lifecycle_owner, lifecycle_state,
    writer_operation, payload_hash_scheme, payload_hash_value, maker_user_id, claimed_by_user_id, correlation_id
  ) VALUES (
    v_voucher, p_org, CASE WHEN COALESCE(p_system_source,'invoice.refund') = 'termination.refund'
                           THEN 'TERMINATION_REFUND' ELSE 'INVOICE_REFUND' END, 2,
    'INVOICE_REFUND', 'UNAPPROVED', 'invoice.refund.reserve.v2', 'md5', v_hash, p_actor_user, p_actor_user,
    p_idempotency_key
  );

  INSERT INTO app_private.invoice_refund_reservations (
    id, organization_id, invoice_id, refund_voucher_id, amount, refund_class, reservation_state,
    state_version, idempotency_key, source_payload_hash, created_by_user_id, created_at
  ) VALUES (
    gen_random_uuid(), p_org, p_invoice_id, v_voucher, p_amount, p_refund_class, 'HELD',
    1, p_idempotency_key, v_hash, p_actor_user, now()
  )
  RETURNING id INTO v_existing.id;

  RETURN jsonb_build_object('reservationId', v_existing.id, 'refundVoucherId', v_voucher,
                            'reservationState', 'HELD', 'stateVersion', 1, 'countsInBusinessResult', v_counts, 'replayed', false);
END
$reserve_refund$;
REVOKE ALL ON FUNCTION app_private.reserve_invoice_refund_obligation_v2(uuid, uuid, uuid, numeric, text, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.reserve_invoice_refund_obligation_v2(uuid, uuid, uuid, numeric, text, text, uuid, uuid, text) IS
  'Plan §8.1: birth ONE pending INVOICE_REFUND_OBLIGATION (UNAPPROVED+UNPOSTED) + HELD reservation; concurrent pendings cannot exceed refundable due.';

DROP FUNCTION IF EXISTS app_private.transition_invoice_refund_reservation_v2(uuid, uuid, text, uuid, bigint, text);
CREATE FUNCTION app_private.transition_invoice_refund_reservation_v2(
  p_org uuid, p_reservation_id uuid, p_target_state text, p_posting_id uuid,
  p_expected_state_version bigint, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $trans_refund$
DECLARE
  v_r app_private.invoice_refund_reservations;
  v_new bigint;
BEGIN
  SELECT * INTO v_r FROM app_private.invoice_refund_reservations r
   WHERE r.id = p_reservation_id AND r.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_invoice_refund_reservation_v2: reservation % not found', p_reservation_id USING ERRCODE = 'P0002';
  END IF;
  IF v_r.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'transition_invoice_refund_reservation_v2: state_version mismatch (expected %, found %)',
      p_expected_state_version, v_r.state_version USING ERRCODE = '55000';
  END IF;
  IF p_target_state NOT IN ('CONSUMED','RELEASED','REVERSED') THEN
    RAISE EXCEPTION 'transition_invoice_refund_reservation_v2: invalid target %', p_target_state USING ERRCODE = '22023';
  END IF;
  -- Legal transitions: HELD->CONSUMED (post), HELD->RELEASED (cancel/reject), CONSUMED->REVERSED (reverse).
  IF NOT (
       (v_r.reservation_state = 'HELD'     AND p_target_state IN ('CONSUMED','RELEASED'))
    OR (v_r.reservation_state = 'CONSUMED' AND p_target_state = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'transition_invoice_refund_reservation_v2: illegal % -> %', v_r.reservation_state, p_target_state USING ERRCODE = '55000';
  END IF;
  IF p_target_state = 'CONSUMED' AND p_posting_id IS NULL THEN
    RAISE EXCEPTION 'transition_invoice_refund_reservation_v2: CONSUMED requires a posting id' USING ERRCODE = '22023';
  END IF;

  v_new := v_r.state_version + 1;
  UPDATE app_private.invoice_refund_reservations r
     SET reservation_state = p_target_state,
         state_version = v_new,
         consumed_posting_id = CASE WHEN p_target_state = 'CONSUMED' THEN p_posting_id ELSE r.consumed_posting_id END,
         reversed_posting_id = CASE WHEN p_target_state = 'REVERSED' THEN p_posting_id ELSE r.reversed_posting_id END,
         state_changed_at = now(), state_reason = p_reason
   WHERE r.id = p_reservation_id;

  RETURN jsonb_build_object('reservationId', p_reservation_id, 'reservationState', p_target_state, 'stateVersion', v_new);
END
$trans_refund$;
REVOKE ALL ON FUNCTION app_private.transition_invoice_refund_reservation_v2(uuid, uuid, text, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.transition_invoice_refund_reservation_v2(uuid, uuid, text, uuid, bigint, text) IS
  'Plan §8.1: HELD->CONSUMED(post)/RELEASED(cancel), CONSUMED->REVERSED(reverse); approve-only does not touch this ledger.';

-- =====================================================================
-- §6.7 PART 6 — profit payout reservation transition (HELD/CONSUMED/RELEASED/REVERSED).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.transition_profit_payout_reservation_v2(uuid, uuid, text, uuid, bigint, text);
CREATE FUNCTION app_private.transition_profit_payout_reservation_v2(
  p_org uuid, p_reservation_id uuid, p_target_state text, p_posting_id uuid,
  p_expected_state_version bigint, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $trans_profit$
DECLARE
  v_r public.profit_payout_reservations;
  v_cur text;
  v_new bigint;
BEGIN
  SELECT * INTO v_r FROM public.profit_payout_reservations r
   WHERE r.id = p_reservation_id AND r.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_profit_payout_reservation_v2: reservation % not found', p_reservation_id USING ERRCODE = 'P0002';
  END IF;
  v_cur := COALESCE(v_r.reservation_state, 'HELD');
  IF COALESCE(v_r.state_version, 1) <> p_expected_state_version THEN
    RAISE EXCEPTION 'transition_profit_payout_reservation_v2: state_version mismatch (expected %, found %)',
      p_expected_state_version, COALESCE(v_r.state_version, 1) USING ERRCODE = '55000';
  END IF;
  IF p_target_state NOT IN ('CONSUMED','RELEASED','REVERSED') THEN
    RAISE EXCEPTION 'transition_profit_payout_reservation_v2: invalid target %', p_target_state USING ERRCODE = '22023';
  END IF;
  IF NOT (
       (v_cur = 'HELD'     AND p_target_state IN ('CONSUMED','RELEASED'))
    OR (v_cur = 'CONSUMED' AND p_target_state = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'transition_profit_payout_reservation_v2: illegal % -> %', v_cur, p_target_state USING ERRCODE = '55000';
  END IF;
  IF p_target_state = 'CONSUMED' AND p_posting_id IS NULL THEN
    RAISE EXCEPTION 'transition_profit_payout_reservation_v2: CONSUMED requires posting id' USING ERRCODE = '22023';
  END IF;

  v_new := COALESCE(v_r.state_version, 1) + 1;
  UPDATE public.profit_payout_reservations r
     SET reservation_state = p_target_state,
         state_version = v_new,
         consumed_posting_id = CASE WHEN p_target_state = 'CONSUMED' THEN p_posting_id ELSE r.consumed_posting_id END,
         reversed_posting_id = CASE WHEN p_target_state = 'REVERSED' THEN p_posting_id ELSE r.reversed_posting_id END,
         state_changed_at = now(), state_reason = p_reason
   WHERE r.id = p_reservation_id;

  RETURN jsonb_build_object('reservationId', p_reservation_id, 'reservationState', p_target_state, 'stateVersion', v_new);
END
$trans_profit$;
REVOKE ALL ON FUNCTION app_private.transition_profit_payout_reservation_v2(uuid, uuid, text, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.transition_profit_payout_reservation_v2(uuid, uuid, text, uuid, bigint, text) IS
  'Plan §6.7/§8: atomic reservation transition; money truth is SUM(HELD+CONSUMED), never the approval_requests enum.';

-- =====================================================================
-- §6.8 PART 7 — termination forfeit pair adapter (one request per pair, no cash).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.transition_termination_forfeit_pair_v2(uuid, uuid, text, text);
CREATE FUNCTION app_private.transition_termination_forfeit_pair_v2(
  p_org uuid, p_revenue_voucher_id uuid, p_decision text, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $forfeit_pair$
DECLARE
  v_auth app_private.termination_forfeit_authorizations;
  v_leg1 uuid;
  v_leg2 uuid;
  v_new_status text;
  v_new_posting text;
BEGIN
  IF p_decision NOT IN ('approve','cancel') THEN
    RAISE EXCEPTION 'transition_termination_forfeit_pair_v2: unsupported pair decision % (reverse is append-only elsewhere)', p_decision USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_auth FROM app_private.termination_forfeit_authorizations a
   WHERE a.revenue_voucher_id = p_revenue_voucher_id AND a.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_termination_forfeit_pair_v2: no forfeit authorization for revenue voucher %', p_revenue_voucher_id USING ERRCODE = 'P0002';
  END IF;

  -- Lock both legs in id order (deadlock-free); both are NON_CASH / NOT_APPLICABLE, no posting.
  v_leg1 := LEAST(v_auth.revenue_voucher_id, v_auth.offset_voucher_id);
  v_leg2 := GREATEST(v_auth.revenue_voucher_id, v_auth.offset_voucher_id);
  PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_leg1 FOR UPDATE;
  PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_leg2 FOR UPDATE;

  v_new_status  := CASE WHEN p_decision = 'approve' THEN 'APPROVED' ELSE 'CANCELLED' END;
  v_new_posting := 'NOT_APPLICABLE';

  PERFORM app_private.finance_v2_transition_owned_approval(v_auth.revenue_voucher_id, v_new_status, v_new_posting);
  PERFORM app_private.finance_v2_transition_owned_approval(v_auth.offset_voucher_id,  v_new_status, v_new_posting);

  RETURN jsonb_build_object('pair', 'TERMINATION_FORFEIT_PAIR_V2',
                            'revenueVoucherId', v_auth.revenue_voucher_id,
                            'offsetVoucherId', v_auth.offset_voucher_id,
                            'decision', p_decision, 'approvalStatus', v_new_status);
END
$forfeit_pair$;
REVOKE ALL ON FUNCTION app_private.transition_termination_forfeit_pair_v2(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.transition_termination_forfeit_pair_v2(uuid, uuid, text, text) IS
  'Plan §6.8: approve/cancel BOTH forfeit legs + non-cash settlement atomically; generic per-leg action is blocked by flow ownership.';

-- =====================================================================
-- §6.9 PART 8 — termination move-out pair adapter + append-only reverse.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.transition_termination_move_out_pair_v2(uuid, uuid, text, text);
CREATE FUNCTION app_private.transition_termination_move_out_pair_v2(
  p_org uuid, p_authorization_id uuid, p_decision text, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $moveout_pair$
DECLARE
  v_auth public.termination_move_out_authorizations;
  v_leg1 uuid;
  v_leg2 uuid;
  v_bad_funding int;
  v_new_status text;
BEGIN
  IF p_decision NOT IN ('approve','cancel') THEN
    RAISE EXCEPTION 'transition_termination_move_out_pair_v2: unsupported decision %', p_decision USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_auth FROM public.termination_move_out_authorizations a
   WHERE a.id = p_authorization_id AND a.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_termination_move_out_pair_v2: authorization % not found', p_authorization_id USING ERRCODE = 'P0002';
  END IF;
  IF v_auth.state <> 'PLANNED' THEN
    RAISE EXCEPTION 'transition_termination_move_out_pair_v2: authorization % not PLANNED (%)', p_authorization_id, v_auth.state USING ERRCODE = '55000';
  END IF;

  -- Settlement funding is restricted to DEPOSIT_OFFSET / CUSTOMER_CREDIT (no CASH_DUE).
  SELECT count(*) INTO v_bad_funding FROM public.termination_move_out_settlement_lines l
   WHERE l.authorization_id = p_authorization_id AND l.funding_kind NOT IN ('DEPOSIT_OFFSET','CUSTOMER_CREDIT');
  IF v_bad_funding > 0 THEN
    RAISE EXCEPTION 'transition_termination_move_out_pair_v2: authorization % has non-offset funding lines', p_authorization_id USING ERRCODE = '55000';
  END IF;

  v_new_status := CASE WHEN p_decision = 'approve' THEN 'APPROVED' ELSE 'CANCELLED' END;

  IF v_auth.revenue_voucher_id IS NOT NULL AND v_auth.offset_voucher_id IS NOT NULL THEN
    v_leg1 := LEAST(v_auth.revenue_voucher_id, v_auth.offset_voucher_id);
    v_leg2 := GREATEST(v_auth.revenue_voucher_id, v_auth.offset_voucher_id);
    PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_leg1 FOR UPDATE;
    PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_leg2 FOR UPDATE;
    PERFORM app_private.finance_v2_transition_owned_approval(v_auth.revenue_voucher_id, v_new_status, 'NOT_APPLICABLE');
    PERFORM app_private.finance_v2_transition_owned_approval(v_auth.offset_voucher_id,  v_new_status, 'NOT_APPLICABLE');
  END IF;

  UPDATE public.termination_move_out_authorizations a
     SET state = v_new_status
   WHERE a.id = p_authorization_id;

  RETURN jsonb_build_object('authorizationId', p_authorization_id, 'decision', p_decision,
                            'state', v_new_status, 'pairVersion', v_auth.pair_version);
END
$moveout_pair$;
REVOKE ALL ON FUNCTION app_private.transition_termination_move_out_pair_v2(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.transition_termination_move_out_pair_v2(uuid, uuid, text, text) IS
  'Plan §6.9: approve/cancel one move-out pair; materialize DEPOSIT_OFFSET/CUSTOMER_CREDIT settlement only, no cash posting.';

DROP FUNCTION IF EXISTS app_private.reverse_termination_move_out_pair_v2(uuid, uuid, text);
CREATE FUNCTION app_private.reverse_termination_move_out_pair_v2(
  p_org uuid, p_authorization_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $moveout_rev$
DECLARE
  v_auth public.termination_move_out_authorizations;
BEGIN
  SELECT * INTO v_auth FROM public.termination_move_out_authorizations a
   WHERE a.id = p_authorization_id AND a.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_termination_move_out_pair_v2: authorization % not found', p_authorization_id USING ERRCODE = 'P0002';
  END IF;
  IF v_auth.state <> 'APPROVED' THEN
    RAISE EXCEPTION 'reverse_termination_move_out_pair_v2: only an APPROVED move-out pair can be reversed (%)', v_auth.state USING ERRCODE = '55000';
  END IF;

  IF v_auth.revenue_voucher_id IS NOT NULL THEN
    PERFORM app_private.finance_v2_transition_owned_approval(v_auth.revenue_voucher_id, 'CANCELLED', 'NOT_APPLICABLE');
  END IF;
  IF v_auth.offset_voucher_id IS NOT NULL THEN
    PERFORM app_private.finance_v2_transition_owned_approval(v_auth.offset_voucher_id, 'CANCELLED', 'NOT_APPLICABLE');
  END IF;

  UPDATE public.termination_move_out_authorizations a SET state = 'REVERSED' WHERE a.id = p_authorization_id;
  RETURN jsonb_build_object('authorizationId', p_authorization_id, 'state', 'REVERSED');
END
$moveout_rev$;
REVOKE ALL ON FUNCTION app_private.reverse_termination_move_out_pair_v2(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.reverse_termination_move_out_pair_v2(uuid, uuid, text) IS
  'Plan §6.9: append-only reverse of one approved move-out pair; both legs CANCELLED, no cash posting created.';

-- =====================================================================
-- §6.10/§6.11 PART 9 — salary settlement bundle adapters (§2.6-gated stubs where required).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_require_policy(uuid, text);
CREATE FUNCTION app_private.finance_v2_require_policy(p_org uuid, p_policy_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $req_policy$
BEGIN
  IF p_policy_key IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_private.finance_business_policy_decisions d
    WHERE d.organization_id = p_org AND d.policy_key = p_policy_key
  ) THEN
    RAISE EXCEPTION 'finance_v2: business-policy decision % not made for org % (§2.6 required)', p_policy_key, p_org
      USING ERRCODE = '0A000';  -- feature_not_supported
  END IF;
END
$req_policy$;
REVOKE ALL ON FUNCTION app_private.finance_v2_require_policy(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_require_policy(uuid, text) IS
  'Plan §2.6: gate a system adapter on an immutable per-org business-policy decision; RAISE feature_not_supported (0A000) when absent.';

DROP FUNCTION IF EXISTS app_private.transition_salary_settlement_bundle_v2(uuid, uuid, text, text);
CREATE FUNCTION app_private.transition_salary_settlement_bundle_v2(
  p_org uuid, p_bundle_id uuid, p_decision text, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $salary_bundle$
DECLARE
  v_b public.salary_settlement_bundles;
  v_new_state text;
BEGIN
  IF p_decision NOT IN ('approve','reject','cancel') THEN
    RAISE EXCEPTION 'transition_salary_settlement_bundle_v2: unsupported decision %', p_decision USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_b FROM public.salary_settlement_bundles b
   WHERE b.id = p_bundle_id AND b.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_salary_settlement_bundle_v2: bundle % not found', p_bundle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_b.state <> 'PENDING' THEN
    RAISE EXCEPTION 'transition_salary_settlement_bundle_v2: bundle % not PENDING (%)', p_bundle_id, v_b.state USING ERRCODE = '55000';
  END IF;

  -- §2.6: rent-offset / commission policy required before an approve materializes non-cash.
  IF p_decision = 'approve' THEN
    PERFORM app_private.finance_v2_require_policy(p_org, 'salary.settlement.v2');

    -- Approve parent (NON_CASH gross P&L) + the ONE_SHOT/MULTI_TRANCHE authorization birthed earlier.
    IF v_b.parent_voucher_id IS NOT NULL THEN
      PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_b.parent_voucher_id FOR UPDATE;
      PERFORM app_private.finance_v2_transition_owned_approval(v_b.parent_voucher_id, 'APPROVED', 'NOT_APPLICABLE');
    END IF;

    -- Materialize planned rent-offset non-cash exactly ONCE at approve (guarded by earning consumption HELD->CONSUMED).
    UPDATE public.salary_earning_consumptions c
       SET consumption_state = 'CONSUMED', state_version = c.state_version + 1
     WHERE c.bundle_id = p_bundle_id AND c.consumption_state = 'HELD';

    v_new_state := 'APPROVED';
  ELSE
    -- reject/cancel: release held earnings, cancel parent.
    UPDATE public.salary_earning_consumptions c
       SET consumption_state = 'RELEASED', state_version = c.state_version + 1
     WHERE c.bundle_id = p_bundle_id AND c.consumption_state = 'HELD';
    IF v_b.parent_voucher_id IS NOT NULL THEN
      PERFORM 1 FROM public.income_expenses ie WHERE ie.id = v_b.parent_voucher_id FOR UPDATE;
      PERFORM app_private.finance_v2_transition_owned_approval(v_b.parent_voucher_id, 'CANCELLED', 'NOT_APPLICABLE');
    END IF;
    v_new_state := 'CANCELLED';
  END IF;

  UPDATE public.salary_settlement_bundles b SET state = v_new_state WHERE b.id = p_bundle_id;
  RETURN jsonb_build_object('bundleId', p_bundle_id, 'decision', p_decision, 'state', v_new_state);
END
$salary_bundle$;
REVOKE ALL ON FUNCTION app_private.transition_salary_settlement_bundle_v2(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.transition_salary_settlement_bundle_v2(uuid, uuid, text, text) IS
  'Plan §6.10/§2.6: one request approves parent + child/authorization; rent-offset non-cash materialized ONCE at approve. Policy-gated.';

DROP FUNCTION IF EXISTS app_private.supersede_salary_settlement_bundle_v2(uuid, uuid, uuid, text);
CREATE FUNCTION app_private.supersede_salary_settlement_bundle_v2(
  p_org uuid, p_bundle_id uuid, p_new_bundle_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $salary_super$
DECLARE
  v_b public.salary_settlement_bundles;
BEGIN
  SELECT * INTO v_b FROM public.salary_settlement_bundles b
   WHERE b.id = p_bundle_id AND b.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supersede_salary_settlement_bundle_v2: bundle % not found', p_bundle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_b.state NOT IN ('PENDING','APPROVED') THEN
    RAISE EXCEPTION 'supersede_salary_settlement_bundle_v2: bundle % not supersedable (%)', p_bundle_id, v_b.state USING ERRCODE = '55000';
  END IF;
  -- §2.6 rent-offset supersession is a policy decision; stub until decided.
  PERFORM app_private.finance_v2_require_policy(p_org, 'salary.settlement.v2');

  -- Release held earnings on the superseded bundle; the replacement bundle re-holds its own.
  UPDATE public.salary_earning_consumptions c
     SET consumption_state = 'RELEASED', state_version = c.state_version + 1
   WHERE c.bundle_id = p_bundle_id AND c.consumption_state = 'HELD';

  UPDATE public.salary_settlement_bundles b SET state = 'SUPERSEDED' WHERE b.id = p_bundle_id;
  RETURN jsonb_build_object('bundleId', p_bundle_id, 'supersededBy', p_new_bundle_id, 'state', 'SUPERSEDED');
END
$salary_super$;
REVOKE ALL ON FUNCTION app_private.supersede_salary_settlement_bundle_v2(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.supersede_salary_settlement_bundle_v2(uuid, uuid, uuid, text) IS
  'Plan §6.10/§2.6: supersede a bundle (release held earnings); policy-gated stub for rent-offset supersession.';

DROP FUNCTION IF EXISTS app_private.post_salary_settlement_tranche_v2(uuid, uuid, uuid, date, uuid);
CREATE FUNCTION app_private.post_salary_settlement_tranche_v2(
  p_org uuid, p_tranche_id uuid, p_cashbook uuid, p_posted_on date, p_actor_membership uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $salary_tranche$
DECLARE
  v_tr public.salary_settlement_tranches;
  v_bundle public.salary_settlement_bundles;
  v_ceiling numeric(18,2);
  v_posted_sum numeric(18,2);
  v_posting_id uuid;
BEGIN
  SELECT * INTO v_tr FROM public.salary_settlement_tranches t
   WHERE t.id = p_tranche_id AND t.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: tranche % not found', p_tranche_id USING ERRCODE = 'P0002';
  END IF;
  IF v_tr.tranche_state <> 'PENDING' THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: tranche % not PENDING (%)', p_tranche_id, v_tr.tranche_state USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_bundle FROM public.salary_settlement_bundles b WHERE b.id = v_tr.bundle_id FOR UPDATE;
  IF NOT FOUND OR v_bundle.state <> 'APPROVED' THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: bundle for tranche % not APPROVED', p_tranche_id USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.finance_v2_require_policy(p_org, 'salary.settlement.v2');

  SELECT ca.ceiling_amount INTO v_ceiling FROM public.salary_cash_authorizations ca WHERE ca.bundle_id = v_tr.bundle_id;
  IF v_ceiling IS NULL THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: bundle % has no MULTI_TRANCHE authorization', v_tr.bundle_id USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(sum(t.amount), 0) INTO v_posted_sum
  FROM public.salary_settlement_tranches t
  WHERE t.bundle_id = v_tr.bundle_id AND t.tranche_state = 'POSTED';

  IF v_posted_sum + v_tr.amount > v_ceiling THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: cumulative % + % exceeds ceiling %', v_posted_sum, v_tr.amount, v_ceiling USING ERRCODE = '55000';
  END IF;

  IF NOT app_private.finance_v2_is_cashbook_period_open(p_org, p_cashbook, p_posted_on) THEN
    RAISE EXCEPTION 'post_salary_settlement_tranche_v2: posted_on % inside a locked cashbook period', p_posted_on USING ERRCODE = '55000';
  END IF;

  v_posting_id := gen_random_uuid();
  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation, created_at
  ) VALUES (
    v_posting_id, p_org, NULL, 'SALARY_TRANCHE', p_tranche_id,
    'EXPENSE', p_cashbook, v_tr.amount, v_tr.amount, 'SALARY_TRANCHE_CASH',
    -v_tr.amount, p_posted_on, p_actor_membership,
    (SELECT om.user_id FROM public.organization_memberships om WHERE om.id = p_actor_membership),
    1, 'POSTING', 'fin_v2:salary_tranche:' || p_tranche_id::text, 'SALARY_BUNDLE_ADAPTER', v_tr.sequence, now()
  );
  INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
  VALUES (gen_random_uuid(), p_org, v_posting_id, p_cashbook, 'MAIN', -v_tr.amount, now());

  UPDATE public.salary_settlement_tranches t
     SET tranche_state = 'POSTED', account_id = p_cashbook, posted_on = p_posted_on,
         active_posting_id = v_posting_id, state_version = t.state_version + 1
   WHERE t.id = p_tranche_id;

  RETURN jsonb_build_object('trancheId', p_tranche_id, 'postingId', v_posting_id, 'trancheState', 'POSTED',
                            'cumulativePosted', v_posted_sum + v_tr.amount, 'ceiling', v_ceiling);
END
$salary_tranche$;
REVOKE ALL ON FUNCTION app_private.post_salary_settlement_tranche_v2(uuid, uuid, uuid, date, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.post_salary_settlement_tranche_v2(uuid, uuid, uuid, date, uuid) IS
  'Plan §6.10/§7.2: post one MULTI_TRANCHE cash amount keeping cumulative <= ceiling; only active tranche posting increases paid. Policy-gated.';

-- =====================================================================
-- §8.1 PART 10 — deferred customer credit enqueue (remediation queue only).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.enqueue_deferred_customer_credit_v2(uuid, text, uuid, uuid, uuid, numeric, text, jsonb);
CREATE FUNCTION app_private.enqueue_deferred_customer_credit_v2(
  p_org uuid, p_source_kind text, p_source_id uuid, p_customer_id uuid, p_invoice_id uuid,
  p_amount numeric, p_wrapper_idempotency_key text, p_detail jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $enqueue_credit$
DECLARE
  v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'enqueue_deferred_customer_credit_v2: amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_wrapper_idempotency_key IS NULL OR length(p_wrapper_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'enqueue_deferred_customer_credit_v2: wrapper idempotency key required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.deferred_customer_credit_queue (
    id, organization_id, source_kind, source_id, customer_id, invoice_id, amount,
    queue_state, wrapper_idempotency_key, detail
  ) VALUES (
    gen_random_uuid(), p_org, p_source_kind, p_source_id, p_customer_id, p_invoice_id, p_amount,
    'PENDING', p_wrapper_idempotency_key, COALESCE(p_detail, '{}'::jsonb)
  )
  ON CONFLICT (organization_id, source_kind, source_id, wrapper_idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT q.id INTO v_id FROM app_private.deferred_customer_credit_queue q
     WHERE q.organization_id = p_org AND q.source_kind = p_source_kind
       AND q.source_id = p_source_id AND q.wrapper_idempotency_key = p_wrapper_idempotency_key;
  END IF;
  RETURN v_id;
END
$enqueue_credit$;
REVOKE ALL ON FUNCTION app_private.enqueue_deferred_customer_credit_v2(uuid, text, uuid, uuid, uuid, numeric, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.enqueue_deferred_customer_credit_v2(uuid, text, uuid, uuid, uuid, numeric, text, jsonb) IS
  'Plan §8.1: durable remediation row for wrapper deferred=true credit; a PENDING row is NOT applied/refunded; separate resolver namespace.';

-- =====================================================================
-- §7.1 PART 11 — dispatch_finance_decision_v2 (fail-closed flow-owner router).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.dispatch_finance_decision_v2(uuid, text, jsonb);
CREATE FUNCTION app_private.dispatch_finance_decision_v2(
  p_subject_id uuid, p_decision text, p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $dispatch$
DECLARE
  v_ie public.income_expenses;
  v_own app_private.income_expense_flow_ownership;
  v_owner_key text;
  v_adp app_private.finance_flow_owner_adapters;
  v_org uuid;
BEGIN
  IF p_decision IS NULL OR length(btrim(p_decision)) = 0 THEN
    RAISE EXCEPTION 'dispatch_finance_decision_v2: decision required' USING ERRCODE = '22023';
  END IF;

  -- Lock the subject voucher (composite subjects pass a member/leg voucher id) + its flow-ownership row.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_subject_id FOR UPDATE;
  IF FOUND THEN
    v_org := v_ie.organization_id;
  END IF;

  SELECT * INTO v_own FROM app_private.income_expense_flow_ownership o
   WHERE o.income_expense_id = p_subject_id FOR UPDATE;

  IF NOT FOUND THEN
    -- No ownership row => MANUAL. Manual subjects are served by the Stage-5 public RPCs, not this router.
    v_owner_key := 'MANUAL';
  ELSE
    v_owner_key := v_own.flow_kind;
    v_org := COALESCE(v_org, v_own.organization_id);
  END IF;

  SELECT * INTO v_adp FROM app_private.finance_flow_owner_adapters a WHERE a.flow_owner = v_owner_key;
  IF NOT FOUND THEN
    -- Unknown / non-decision owner (e.g. a POSTED collection) — fail closed, never fall back to manual.
    RAISE EXCEPTION 'dispatch_finance_decision_v2: unknown flow owner % for subject % (fail closed)', v_owner_key, p_subject_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT (p_decision = ANY (v_adp.supported_decisions)) THEN
    RAISE EXCEPTION 'dispatch_finance_decision_v2: owner % does not support decision %', v_owner_key, p_decision
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_adp.is_system_owned THEN
    RAISE EXCEPTION 'dispatch_finance_decision_v2: subject % is MANUAL; call the Stage-5 manual RPC directly', p_subject_id
      USING ERRCODE = '42501';
  END IF;

  -- §2.6 policy gate for owners that require a business-policy decision.
  PERFORM app_private.finance_v2_require_policy(v_org, v_adp.requires_policy_key);

  -- Route to the registered adapter. Composite adapters read their own keys from p_payload.
  CASE v_adp.adapter_name
    WHEN 'INVOICE_REFUND' THEN
      -- approve-only NEVER touches the reservation ledger / refunded cash (plan §8.1).
      IF p_decision = 'approve' THEN
        PERFORM app_private.finance_v2_transition_owned_approval(p_subject_id, 'APPROVED', 'UNPOSTED');
        RETURN jsonb_build_object('refundVoucherId', p_subject_id, 'approvalStatus', 'APPROVED', 'reservationUnchanged', true);
      ELSIF p_decision IN ('reject','cancel') THEN
        PERFORM app_private.finance_v2_transition_owned_approval(p_subject_id, 'CANCELLED', 'UNPOSTED');
        RETURN app_private.transition_invoice_refund_reservation_v2(
          v_org, (p_payload->>'reservationId')::uuid, 'RELEASED', NULL,
          (p_payload->>'expectedStateVersion')::bigint, p_payload->>'reason');
      ELSE  -- post / reverse consume/release with the posting linkage
        RETURN app_private.transition_invoice_refund_reservation_v2(
          v_org, (p_payload->>'reservationId')::uuid,
          CASE p_decision WHEN 'post' THEN 'CONSUMED' ELSE 'REVERSED' END,
          (p_payload->>'postingId')::uuid, (p_payload->>'expectedStateVersion')::bigint, p_payload->>'reason');
      END IF;
    WHEN 'PROFIT_PAYOUT' THEN
      IF p_decision = 'approve' THEN
        RETURN jsonb_build_object('reservationUnchanged', true, 'decision', 'approve');
      ELSE
        RETURN app_private.transition_profit_payout_reservation_v2(
          v_org, (p_payload->>'reservationId')::uuid,
          CASE p_decision WHEN 'post' THEN 'CONSUMED' WHEN 'reverse' THEN 'REVERSED' ELSE 'RELEASED' END,
          (p_payload->>'postingId')::uuid, (p_payload->>'expectedStateVersion')::bigint, p_payload->>'reason');
      END IF;
    WHEN 'TERMINATION_FORFEIT_PAIR' THEN
      RETURN app_private.transition_termination_forfeit_pair_v2(
        v_org, p_subject_id, p_decision, p_payload->>'reason');
    WHEN 'TERMINATION_MOVE_OUT_PAIR' THEN
      IF p_decision = 'reverse' THEN
        RETURN app_private.reverse_termination_move_out_pair_v2(v_org, (p_payload->>'authorizationId')::uuid, p_payload->>'reason');
      ELSE
        RETURN app_private.transition_termination_move_out_pair_v2(v_org, (p_payload->>'authorizationId')::uuid, p_decision, p_payload->>'reason');
      END IF;
    WHEN 'SALARY_BUNDLE' THEN
      RETURN app_private.transition_salary_settlement_bundle_v2(v_org, (p_payload->>'bundleId')::uuid, p_decision, p_payload->>'reason');
    ELSE
      RAISE EXCEPTION 'dispatch_finance_decision_v2: adapter % not wired for decision routing', v_adp.adapter_name
        USING ERRCODE = '0A000';
  END CASE;
END
$dispatch$;
REVOKE ALL ON FUNCTION app_private.dispatch_finance_decision_v2(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.dispatch_finance_decision_v2(uuid, text, jsonb) IS
  'Plan §7.1/§8: lock flow owner + approval subject, route decision to the registered adapter; unknown owner fails closed (no manual fallback).';

-- =====================================================================
-- PART 12 — Stamp the flow-owned POSTED headers left NULL by Stage-4 backfill.
-- Determinable = a LEGACY_BACKFILL POSTING event exists and the voucher is flow-owned.
-- Others record a deferred reason in the backfill exception table (never guessed).
-- =====================================================================
DO $stamp_owned_posted$
DECLARE
  v_row record;
  v_stamped int := 0;
BEGIN
  -- Guard: only run once Stage-2 columns + Stage-4 postings exist (compile-safe on partial applies).
  IF to_regclass('public.income_expense_postings') IS NULL THEN
    RETURN;
  END IF;

  FOR v_row IN
    SELECT ie.id AS voucher_id, ie.organization_id, ie.counts_in_business_result, ie.voucher_date,
           ie.recognition_source_mode, p.id AS posting_id, a.is_virtual
    FROM public.income_expenses ie
    JOIN app_private.income_expense_flow_ownership o ON o.income_expense_id = ie.id
    JOIN public.income_expense_postings p
      ON p.posting_subject_id = ie.id AND p.posting_subject_kind = 'VOUCHER'
     AND p.event_kind = 'POSTING' AND p.source_kind = 'LEGACY_BACKFILL'
     AND p.organization_id = ie.organization_id
    LEFT JOIN public.accounts a ON a.id = ie.account_id
    WHERE ie.posting_status IS NULL
      AND ie.deleted_at IS NULL
  LOOP
    -- Cash-posted flow-owned header (e.g. V5 collection): POSTED + active pointer.
    -- Fail-safe: if a stricter owned-payload guard rejects the token path, record the
    -- reason and continue (the migration never aborts; un-stamped headers are dispositioned).
    BEGIN
      PERFORM app_private.finance_v2_stamp_owned_posting_state(
        v_row.voucher_id, 'POSTED', v_row.posting_id, 'RESOLVED',
        CASE WHEN v_row.counts_in_business_result THEN 'BASE' ELSE v_row.recognition_source_mode END,
        CASE WHEN v_row.counts_in_business_result THEN v_row.voucher_date ELSE NULL END);
      v_stamped := v_stamped + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (v_row.organization_id, v_row.voucher_id, 'FLOW_OWNED_HEADER_STAMP_BLOCKED',
              jsonb_build_object('posting_id', v_row.posting_id, 'sqlstate', SQLSTATE, 'message', SQLERRM))
      ON CONFLICT DO NOTHING;
    END;
  END LOOP;

  -- Record why the remaining flow-owned headers stay NULL (NON_CASH forfeit/salary/profit — reconciled by their own adapter path at approve/post, not backfill).
  INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
  SELECT ie.organization_id, ie.id, 'FLOW_OWNED_HEADER_DEFERRED',
         jsonb_build_object('flow_kind', o.flow_kind, 'system_source', ie.system_source,
                            'note', 'NON_CASH flow-owned header reconciled by owning adapter at approve/post, not by Stage-4/Stage-6 backfill')
  FROM public.income_expenses ie
  JOIN app_private.income_expense_flow_ownership o ON o.income_expense_id = ie.id
  WHERE ie.posting_status IS NULL
    AND ie.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.income_expense_postings p
      WHERE p.posting_subject_id = ie.id AND p.posting_subject_kind = 'VOUCHER'
        AND p.event_kind = 'POSTING' AND p.source_kind = 'LEGACY_BACKFILL'
        AND p.organization_id = ie.organization_id)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Finance V2 Stage-6: stamped % flow-owned POSTED headers via owning-adapter token path', v_stamped;
END
$stamp_owned_posted$;

-- =====================================================================
-- PART 13 — Companion-pair P&L resolver forward-fix (plan §8.1 / 20260721132500).
-- The historical resolver paired the retired system_source 'invoice.payment' with
-- 'contract.deposit'; V5 renamed the direct receipt to 'invoice.collection.v5'.
-- Re-resolve the two known split-receipt integrity exceptions for the V5 source,
-- fail-open (skip) when the exact reviewed shape is not present (never guess).
-- =====================================================================
DO $companion_pair_fix$
DECLARE
  v_pair record;
  v_ok boolean;
BEGIN
  IF to_regclass('public.accounting_integrity_exceptions') IS NULL THEN
    RETURN;
  END IF;

  FOR v_pair IN
    SELECT * FROM (VALUES
      ('12357610-2d88-44dc-ae4a-b5064b75b704'::uuid, '4deb6e9c-4c92-4e54-899b-a490e44ca386'::uuid, '8ad577fd-3253-46b3-855d-3c7fea72407d'::uuid, 6550000::numeric),
      ('1b6a6fe5-20bd-4e2e-9120-dbfc9ce2dbe7'::uuid, 'e913c814-e766-4608-850d-4370ba46af88'::uuid, '11d7c4c6-112d-4a2f-bbf3-fa91da7bc019'::uuid, 1300000::numeric)
    ) AS s(payment_id, direct_voucher_id, companion_voucher_id, expected_amount)
  LOOP
    -- Re-validate the reviewed split under the CURRENT (V5) direct source. Fail-open when absent.
    SELECT EXISTS (
      SELECT 1
      FROM public.payments payment
      JOIN public.income_expenses direct_voucher ON direct_voucher.id = v_pair.direct_voucher_id
      JOIN public.income_expenses companion     ON companion.id     = v_pair.companion_voucher_id
      WHERE payment.id = v_pair.payment_id
        AND payment.amount = v_pair.expected_amount
        AND direct_voucher.organization_id = payment.organization_id
        AND companion.organization_id = payment.organization_id
        AND direct_voucher.invoice_id = payment.invoice_id
        AND companion.invoice_id = payment.invoice_id
        AND direct_voucher.payment_id = payment.id
        AND companion.payment_id IS NULL
        AND direct_voucher.approval_status = 'APPROVED'
        AND companion.approval_status = 'APPROVED'
        AND direct_voucher.deleted_at IS NULL
        AND companion.deleted_at IS NULL
        AND direct_voucher.system_source IN ('invoice.payment','invoice.collection.v5')
        AND companion.system_source = 'contract.deposit'
        AND direct_voucher.total_amount + companion.total_amount = payment.amount
    ) INTO v_ok;

    IF v_ok THEN
      UPDATE public.accounting_integrity_exceptions exception
         SET status = 'RESOLVED',
             resolved_at = clock_timestamp(),
             resolution_note = 'Finance V2 Stage-6: reviewed split revenue/deposit receipt reconciled under invoice.collection.v5 direct source.'
       WHERE exception.status = 'OPEN'
         AND exception.entity_type = 'PAYMENT'
         AND exception.exception_code = 'PAYMENT_VOUCHER_TOTAL_MISMATCH'
         AND exception.entity_id = v_pair.payment_id;
    END IF;
  END LOOP;
END
$companion_pair_fix$;

COMMIT;

NOTIFY pgrst, 'reload schema';
