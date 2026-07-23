-- Finance V2 (Thu Chi V2) — Stage 4: backfill (plan §10.1/§10.2).
-- Populate posting events / recognition / access candidates from existing data, idempotently,
-- producing signed lines that match legacy balance. Ambiguity -> exception tables, never a
-- guess. Never UPDATE/DELETE a posting event. No feature mode changed, no org enrolled.

BEGIN;

-- Finance V2 (Thu Chi V2) — Stage 4: DATA BACKFILL (plan §10.1, §10.2, §8.1, §6.5).
--
-- Populates the Stage-2 Finance V2 schema from existing legacy data, idempotently,
-- producing SIGNED POSTING LINES that reproduce the legacy account balance EXACTLY.
--
-- Balance authority (legacy `accounts_with_balance`, verified 2026-07-22):
--   current_amount = initial_amount
--     + Σ total_amount  (INCOME, account_id,          APPROVED, deleted_at IS NULL)
--     - Σ total_amount  (EXPENSE, account_id,          APPROVED, deleted_at IS NULL)
--     + Σ change_amount (        change_account_id,    APPROVED, deleted_at IS NULL)
--     + Σ rounding_amount(       rounding_account_id,  APPROVED, deleted_at IS NULL)
-- Decomposed 1:1 into posting lines:
--   MAIN     = (INCOME:+ / EXPENSE:-) total_amount  on account_id           (|MAIN| = gross)
--   CHANGE   = + change_amount                       on change_account_id    (when acct & amount set)
--   ROUNDING = + rounding_amount                     on rounding_account_id  (when acct & amount set)
--   net_cash_effect = Σ(signed lines).
--
-- Source-inference order (plan §10.1): already-real-V2-posting (none) → V5 tender →
-- legacy Thu w/ payment → termination/non-cash → legacy APPROVED manual → internal/virtual →
-- exception. Cash-effect postings are created ONLY for REAL (non-virtual) cashbooks; virtual
-- accounts are the internal/non-cash books (plan §10.1 rule 6) and are excluded from cash
-- parity by design. Ambiguity is NEVER guessed — it lands in an exception table (plan §6.5).
--
-- Idempotent: postings keyed by (organization_id, idempotency_key) with ON CONFLICT DO NOTHING;
-- lines/updates/candidates/exceptions guarded by NOT EXISTS / unique keys, so re-apply adds nothing.
-- Runs inside the orchestrator transaction (validated via rollback). NO BEGIN/COMMIT/NOTIFY here.
--
-- Header stamping (income_expenses.posting_mode/posting_status/active_posting_id_v2/...) is applied
-- ONLY to rows that are NOT owned by a system flow. The a00_ie_owned_payload_freeze,
-- guard_termination_forfeit_voucher_v1 and guard_profit_payout_linked_v2 triggers deliberately
-- freeze flow-owned / forfeit / profit-payout voucher headers against generic writers; those headers
-- are reconciled by their owning adapters. Balance parity does NOT depend on the header pointer
-- (readers SUM posting lines, plan §6.2), so deferring flow-owned header stamps is safe.

-- ============================================================================
-- PART A — Private backfill exception staging (plan §6.5). Owner-only, RLS deny-all.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_private.income_expense_v2_backfill_exceptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  voucher_id      uuid        NULL,
  reason_code     text        NOT NULL,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_private.income_expense_v2_backfill_exceptions IS
  'Plan §6.5/§10.1: vouchers the Stage-4 posting backfill could not classify with certainty (never guessed). Cutover is blocked until every row is dispositioned. Owner-only; RLS deny-all.';
-- Deterministic identity so the same unresolved voucher/reason is recorded once (idempotent re-apply).
CREATE UNIQUE INDEX IF NOT EXISTS income_expense_v2_backfill_exceptions_key
  ON app_private.income_expense_v2_backfill_exceptions
     (organization_id, COALESCE(voucher_id, '00000000-0000-0000-0000-000000000000'::uuid), reason_code);
REVOKE ALL ON app_private.income_expense_v2_backfill_exceptions FROM PUBLIC;
DO $exc_ie_acl$
BEGIN
  IF to_regrole('anon')            IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.income_expense_v2_backfill_exceptions FROM anon'; END IF;
  IF to_regrole('authenticated')   IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.income_expense_v2_backfill_exceptions FROM authenticated'; END IF;
  IF to_regrole('service_role')    IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.income_expense_v2_backfill_exceptions FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT ON app_private.income_expense_v2_backfill_exceptions TO ie_canonical_writer'; END IF;
END
$exc_ie_acl$;
ALTER TABLE app_private.income_expense_v2_backfill_exceptions ENABLE ROW LEVEL SECURITY;  -- deny-all: no policy

CREATE TABLE IF NOT EXISTS app_private.cashbook_access_v2_backfill_exceptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  cashbook_id     uuid        NULL,
  membership_id   uuid        NULL,
  reason_code     text        NOT NULL,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_private.cashbook_access_v2_backfill_exceptions IS
  'Plan §6.5/§10.2: cashbook possession candidates the backfill could not attribute to a tenant-consistent (cashbook, membership) — e.g. organization mismatch. Owner-only; RLS deny-all.';
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_access_v2_backfill_exceptions_key
  ON app_private.cashbook_access_v2_backfill_exceptions
     (organization_id,
      COALESCE(cashbook_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(membership_id, '00000000-0000-0000-0000-000000000000'::uuid),
      reason_code);
REVOKE ALL ON app_private.cashbook_access_v2_backfill_exceptions FROM PUBLIC;
DO $exc_cb_acl$
BEGIN
  IF to_regrole('anon')          IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_v2_backfill_exceptions FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_v2_backfill_exceptions FROM authenticated'; END IF;
  IF to_regrole('service_role')  IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_v2_backfill_exceptions FROM service_role'; END IF;
END
$exc_cb_acl$;
ALTER TABLE app_private.cashbook_access_v2_backfill_exceptions ENABLE ROW LEVEL SECURITY;  -- deny-all: no policy

-- ============================================================================
-- PART B — POSTING EVENT BACKFILL (plan §10.1, §6.2). Append-only; never UPDATE/DELETE an event.
-- ============================================================================

-- --- B1. §10.1 rule 5 (merged with rule 3 payment-mirror): legacy APPROVED cash vouchers ----------
-- Real cashbook, APPROVED, not deleted, positive total, NOT a V5 collection voucher. MAIN ±total on
-- account_id (== legacy contribution), amount_basis VOUCHER_TOTAL, gross=snapshot=total_amount.
-- posted_by = historical actor (approved_by, else the voucher's own user_id — the immutable legacy
-- attribution; this is the POSTER, never backfilled as the maker per §6.1/§10.1). Rows whose actor
-- cannot resolve to an ACTIVE membership, or whose total<=0, are diverted to exceptions below.
INSERT INTO public.income_expense_postings (
  id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
  direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
  net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
  approval_request_id, approval_version, event_kind, idempotency_key,
  source_kind, posting_generation, evidence_waiver, legacy_provenance, created_at
)
SELECT
  gen_random_uuid(), ie.organization_id, ie.id, 'VOUCHER', ie.id,
  ie.type, ie.account_id, ie.total_amount, ie.total_amount, 'VOUCHER_TOTAL',
  (CASE WHEN ie.type = 'INCOME' THEN ie.total_amount ELSE -ie.total_amount END)
    + (CASE WHEN ie.change_account_id   IS NOT NULL AND ie.change_amount <> 0                        THEN ie.change_amount   ELSE 0 END)
    + (CASE WHEN ie.rounding_account_id IS NOT NULL AND COALESCE(ie.rounding_amount, 0) <> 0         THEN ie.rounding_amount ELSE 0 END),
  ie.voucher_date, m.membership_id, COALESCE(ie.approved_by, ie.user_id),
  ie.approval_request_id, COALESCE(ie.approval_version, 1), 'POSTING',
  'fin_v2_backfill:legacy:' || ie.id::text,
  'LEGACY_BACKFILL', 1, 'PRE_V2_HISTORY',
  jsonb_build_object('backfill', 'LEGACY_BACKFILL', 'system_source', ie.system_source,
                     'payment_id', ie.payment_id, 'voucher_code', ie.code,
                     'legacy_posting_id_stamp', ie.posting_id),
  now()
FROM public.income_expenses ie
JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
JOIN LATERAL (
  SELECT om.id AS membership_id
  FROM public.organization_memberships om
  WHERE om.organization_id = ie.organization_id
    AND om.user_id = COALESCE(ie.approved_by, ie.user_id)
    AND om.status = 'ACTIVE'
  ORDER BY om.activated_at NULLS LAST, om.id
  LIMIT 1
) m ON true
WHERE ie.approval_status = 'APPROVED'
  AND ie.deleted_at IS NULL
  AND ie.total_amount > 0
  AND ie.payment_collection_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payment_tenders t WHERE t.voucher_id = ie.id)
ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

-- B1 lines: MAIN (|signed| = gross, sign by direction).
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, p.account_id, 'MAIN',
       CASE WHEN p.direction = 'INCOME' THEN p.gross_amount ELSE -p.gross_amount END, now()
FROM public.income_expense_postings p
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'VOUCHER_TOTAL'
  AND p.idempotency_key LIKE 'fin_v2_backfill:legacy:%'
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'MAIN');

-- B1 lines: CHANGE (+change_amount on change_account_id) — legacy sign preserved exactly.
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, ie.change_account_id, 'CHANGE', ie.change_amount, now()
FROM public.income_expense_postings p
JOIN public.income_expenses ie ON ie.id = p.voucher_id
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'VOUCHER_TOTAL'
  AND p.idempotency_key LIKE 'fin_v2_backfill:legacy:%'
  AND ie.change_account_id IS NOT NULL AND ie.change_amount <> 0
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'CHANGE');

-- B1 lines: ROUNDING (+rounding_amount on rounding_account_id) — legacy sign preserved exactly.
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, ie.rounding_account_id, 'ROUNDING', ie.rounding_amount, now()
FROM public.income_expense_postings p
JOIN public.income_expenses ie ON ie.id = p.voucher_id
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'VOUCHER_TOTAL'
  AND p.idempotency_key LIKE 'fin_v2_backfill:legacy:%'
  AND ie.rounding_account_id IS NOT NULL AND COALESCE(ie.rounding_amount, 0) <> 0
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'ROUNDING');

-- --- B2. §10.1 rule 2: Invoice Collection V5 tender POSTING (one lineage per tender) ---------------
-- gross = tender.gross_amount, snapshot = tender.retained_amount, external (COLLECTION_V5, collection, tender).
-- Guarded to gross_amount = voucher total_amount so |MAIN| = gross AND MAIN reproduces the legacy
-- +total contribution on the receiving cashbook simultaneously; any tender where these diverge (e.g.
-- gross>retained change tenders) is diverted to exception B5 and NOT posted.
INSERT INTO public.income_expense_postings (
  id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
  direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
  net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
  approval_request_id, approval_version, event_kind, idempotency_key,
  source_kind, external_source_kind, external_source_id, external_source_line_id,
  posting_generation, evidence_waiver, legacy_provenance, created_at
)
SELECT
  gen_random_uuid(), ie.organization_id, ie.id, 'VOUCHER', ie.id,
  ie.type, ie.account_id, t.gross_amount, t.retained_amount, 'EXTERNAL_TENDER_GROSS',
  (CASE WHEN ie.type = 'INCOME' THEN t.gross_amount ELSE -t.gross_amount END)
    + (CASE WHEN ie.change_account_id   IS NOT NULL AND ie.change_amount <> 0                THEN ie.change_amount   ELSE 0 END)
    + (CASE WHEN ie.rounding_account_id IS NOT NULL AND COALESCE(ie.rounding_amount, 0) <> 0 THEN ie.rounding_amount ELSE 0 END),
  COALESCE(c.collection_date, ie.voucher_date), m.membership_id, COALESCE(ie.approved_by, ie.user_id),
  ie.approval_request_id, COALESCE(ie.approval_version, 1), 'POSTING',
  'fin_v2_backfill:v5:' || t.collection_id::text || ':' || t.id::text,
  'LEGACY_BACKFILL', 'COLLECTION_V5', t.collection_id, t.id,
  1, 'PRE_V2_HISTORY',
  jsonb_build_object('backfill', 'COLLECTION_V5', 'collection_id', t.collection_id,
                     'tender_id', t.id, 'voucher_id', ie.id, 'payment_id', t.payment_id),
  now()
FROM public.invoice_payment_tenders t
JOIN public.income_expenses ie ON ie.id = t.voucher_id
JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
LEFT JOIN public.invoice_payment_collections c ON c.id = t.collection_id
JOIN LATERAL (
  SELECT om.id AS membership_id
  FROM public.organization_memberships om
  WHERE om.organization_id = ie.organization_id
    AND om.user_id = COALESCE(ie.approved_by, ie.user_id)
    AND om.status = 'ACTIVE'
  ORDER BY om.activated_at NULLS LAST, om.id
  LIMIT 1
) m ON true
WHERE ie.approval_status = 'APPROVED'
  AND ie.deleted_at IS NULL
  AND t.gross_amount > 0
  AND t.gross_amount = ie.total_amount
ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

-- B2 lines: MAIN (+gross on the receiving cashbook) + header CHANGE/ROUNDING (legacy fields).
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, p.account_id, 'MAIN',
       CASE WHEN p.direction = 'INCOME' THEN p.gross_amount ELSE -p.gross_amount END, now()
FROM public.income_expense_postings p
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'EXTERNAL_TENDER_GROSS'
  AND p.idempotency_key LIKE 'fin_v2_backfill:v5:%'
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'MAIN');
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, ie.change_account_id, 'CHANGE', ie.change_amount, now()
FROM public.income_expense_postings p
JOIN public.income_expenses ie ON ie.id = p.voucher_id
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'EXTERNAL_TENDER_GROSS'
  AND p.idempotency_key LIKE 'fin_v2_backfill:v5:%'
  AND ie.change_account_id IS NOT NULL AND ie.change_amount <> 0
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'CHANGE');
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, ie.rounding_account_id, 'ROUNDING', ie.rounding_amount, now()
FROM public.income_expense_postings p
JOIN public.income_expenses ie ON ie.id = p.voucher_id
WHERE p.event_kind = 'POSTING' AND p.amount_basis = 'EXTERNAL_TENDER_GROSS'
  AND p.idempotency_key LIKE 'fin_v2_backfill:v5:%'
  AND ie.rounding_account_id IS NOT NULL AND COALESCE(ie.rounding_amount, 0) <> 0
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'ROUNDING');

-- --- B3. §10.1 rule 2 (reversal): V5 collection reversal = a REVERSAL event on the ORIGINAL tender
-- posting (NOT a second independent cash effect). The reverse compatibility voucher is a projection.
INSERT INTO public.income_expense_postings (
  id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
  direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
  net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
  approval_request_id, approval_version, event_kind, idempotency_key,
  source_kind, external_source_kind, external_source_id, external_source_line_id,
  posting_generation, reversal_of_id, reversal_reason, evidence_waiver, legacy_provenance, created_at
)
SELECT
  gen_random_uuid(), orig.organization_id, orig.id, 'VOUCHER', orig.id,
  orig.type, orig.account_id, op.gross_amount, op.voucher_amount_snapshot, 'EXTERNAL_TENDER_GROSS',
  -op.gross_amount,
  COALESCE(c.reversal_date, rv.voucher_date), m.membership_id, COALESCE(rv.approved_by, rv.user_id),
  rv.approval_request_id, COALESCE(orig.approval_version, 1), 'REVERSAL',
  'fin_v2_backfill:v5rev:' || op.external_source_id::text || ':' || op.external_source_line_id::text,
  'LEGACY_BACKFILL', 'COLLECTION_V5', op.external_source_id, op.external_source_line_id,
  op.posting_generation, op.id, 'LEGACY collection reversal (backfill)', 'PRE_V2_HISTORY',
  jsonb_build_object('backfill', 'COLLECTION_V5_REVERSAL', 'reverse_voucher_id', rv.id,
                     'original_voucher_id', orig.id, 'reverses_posting_id', op.id),
  now()
FROM public.income_expenses rv
JOIN public.income_expenses orig ON orig.id = rv.reversal_of_income_expense_id
JOIN public.income_expense_postings op
  ON op.posting_subject_id = orig.id AND op.event_kind = 'POSTING'
 AND op.external_source_kind = 'COLLECTION_V5' AND op.organization_id = orig.organization_id
LEFT JOIN public.invoice_payment_collections c ON c.id = op.external_source_id
JOIN LATERAL (
  SELECT om.id AS membership_id
  FROM public.organization_memberships om
  WHERE om.organization_id = rv.organization_id
    AND om.user_id = COALESCE(rv.approved_by, rv.user_id)
    AND om.status = 'ACTIVE'
  ORDER BY om.activated_at NULLS LAST, om.id
  LIMIT 1
) m ON true
WHERE rv.system_source = 'invoice.collection.reverse.v5'
  AND rv.approval_status = 'APPROVED'
  AND rv.deleted_at IS NULL
ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

-- B3 lines: REVERSAL (-gross on the original cashbook).
INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
SELECT gen_random_uuid(), p.organization_id, p.id, p.account_id, 'REVERSAL',
       CASE WHEN p.direction = 'INCOME' THEN -p.gross_amount ELSE p.gross_amount END, now()
FROM public.income_expense_postings p
WHERE p.event_kind = 'REVERSAL'
  AND p.idempotency_key LIKE 'fin_v2_backfill:v5rev:%'
  AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id AND l.line_kind = 'REVERSAL');

-- --- B4. §10.1 rule 7: NON-POSITIVE total on a real cashbook cannot form a gross>0 posting → exception.
INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
SELECT ie.organization_id, ie.id, 'NON_POSITIVE_TOTAL',
       jsonb_build_object('total_amount', ie.total_amount, 'type', ie.type,
                          'change_amount', ie.change_amount, 'rounding_amount', ie.rounding_amount,
                          'system_source', ie.system_source)
FROM public.income_expenses ie
JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
WHERE ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
  AND ie.total_amount <= 0
  AND ie.payment_collection_id IS NULL
ON CONFLICT DO NOTHING;

-- B4b. §10.1 rule 7: real-cash APPROVED voucher whose historical actor cannot resolve to an ACTIVE
-- membership → cannot attribute posted_by, do NOT guess. (Currently empty; guards future drift.)
INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
SELECT ie.organization_id, ie.id, 'UNRESOLVED_POSTED_BY_ACTOR',
       jsonb_build_object('approved_by', ie.approved_by, 'user_id', ie.user_id, 'system_source', ie.system_source)
FROM public.income_expenses ie
JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
WHERE ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
  AND ie.total_amount > 0
  AND ie.payment_collection_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payment_tenders t WHERE t.voucher_id = ie.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.organization_id = ie.organization_id
      AND om.user_id = COALESCE(ie.approved_by, ie.user_id)
      AND om.status = 'ACTIVE')
ON CONFLICT DO NOTHING;

-- --- B5. §10.1 rule 7: V5 collection voucher that produced no clean lineage.
-- (a) collection-linked voucher that is neither a posted tender nor a reconciled reverse projection.
INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
SELECT ie.organization_id, ie.id, 'V5_UNCLASSIFIED_COLLECTION',
       jsonb_build_object('payment_collection_id', ie.payment_collection_id, 'system_source', ie.system_source,
                          'type', ie.type, 'total_amount', ie.total_amount)
FROM public.income_expenses ie
WHERE ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
  AND ie.payment_collection_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payment_tenders t WHERE t.voucher_id = ie.id)
  AND NOT (
    ie.system_source = 'invoice.collection.reverse.v5'
    AND EXISTS (
      SELECT 1 FROM public.income_expense_postings op
      WHERE op.posting_subject_id = ie.reversal_of_income_expense_id
        AND op.event_kind = 'POSTING' AND op.external_source_kind = 'COLLECTION_V5'
        AND op.organization_id = ie.organization_id))
ON CONFLICT DO NOTHING;
-- (b) tender voucher rejected by the gross=total parity guard in B2.
INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
SELECT ie.organization_id, ie.id, 'V5_GROSS_TOTAL_MISMATCH',
       jsonb_build_object('tender_gross', t.gross_amount, 'tender_retained', t.retained_amount,
                          'voucher_total', ie.total_amount, 'collection_id', t.collection_id, 'tender_id', t.id)
FROM public.invoice_payment_tenders t
JOIN public.income_expenses ie ON ie.id = t.voucher_id
JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
WHERE ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
  AND (t.gross_amount <= 0 OR t.gross_amount <> ie.total_amount)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PART C — HEADER STATE STAMP (plan §6.1). Only rows not owned by a system flow; flow-owned /
-- forfeit / profit-payout / salary voucher headers are frozen by their guards and reconciled by the
-- owning adapter (deferred by design). WHERE posting_status IS NULL makes every stamp idempotent.
-- The predicate below is exactly the set of rows whose UPDATE passes a00_ie_owned_payload_freeze,
-- guard_termination_forfeit_voucher_v1 and guard_profit_payout_linked_v2 without a transition token.
-- ============================================================================

-- C1. POSTED cash rows (a legacy/V5 POSTING exists and points back to this voucher).
UPDATE public.income_expenses ie SET
  posting_mode            = 'CASHBOOK',
  posting_status          = 'POSTED',
  active_posting_id_v2    = p.id,
  review_state            = 'RESOLVED',
  recognition_source_mode = CASE WHEN ie.counts_in_business_result THEN 'BASE'          ELSE ie.recognition_source_mode END,
  recognition_date        = CASE WHEN ie.counts_in_business_result THEN ie.voucher_date ELSE ie.recognition_date END
FROM public.income_expense_postings p
WHERE p.posting_subject_id = ie.id AND p.posting_subject_kind = 'VOUCHER' AND p.event_kind = 'POSTING'
  AND p.source_kind = 'LEGACY_BACKFILL' AND p.organization_id = ie.organization_id
  AND ie.posting_status IS NULL
  AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = ie.id)
  AND COALESCE(ie.system_source, '') NOT IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
  AND ie.salary_staff_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr WHERE pr.payout_voucher_id = ie.id)
  AND NOT EXISTS (SELECT 1 FROM public.approval_requests ar
                  WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ie.id
                    AND ar.system_source = 'profit.distribution');

-- C2. Internal/virtual APPROVED rows → NON_CASH + NOT_APPLICABLE (plan §10.1 rule 6). No posting.
UPDATE public.income_expenses ie SET
  posting_mode            = 'NON_CASH',
  posting_status          = 'NOT_APPLICABLE',
  active_posting_id_v2    = NULL,
  review_state            = 'RESOLVED',
  recognition_source_mode = CASE WHEN ie.counts_in_business_result THEN 'BASE'          ELSE ie.recognition_source_mode END,
  recognition_date        = CASE WHEN ie.counts_in_business_result THEN ie.voucher_date ELSE ie.recognition_date END
FROM public.accounts a
WHERE a.id = ie.account_id AND a.is_virtual = true
  AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
  AND ie.posting_status IS NULL
  AND ie.payment_collection_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = ie.id)
  AND COALESCE(ie.system_source, '') NOT IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
  AND ie.salary_staff_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr WHERE pr.payout_voucher_id = ie.id)
  AND NOT EXISTS (SELECT 1 FROM public.approval_requests ar
                  WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ie.id
                    AND ar.system_source = 'profit.distribution');

-- C3. CANCELLED rows → never posted; terminal state by cash mode (plan §10.3). review_state RESOLVED.
UPDATE public.income_expenses ie SET
  posting_mode   = CASE WHEN a.id IS NOT NULL AND a.is_virtual = false THEN 'CASHBOOK'  ELSE 'NON_CASH' END,
  posting_status = CASE WHEN a.id IS NOT NULL AND a.is_virtual = false THEN 'UNPOSTED'  ELSE 'NOT_APPLICABLE' END,
  review_state   = 'RESOLVED'
FROM (SELECT ie2.id FROM public.income_expenses ie2 WHERE ie2.approval_status = 'CANCELLED' AND ie2.posting_status IS NULL) sel
LEFT JOIN public.accounts a ON a.id = (SELECT account_id FROM public.income_expenses WHERE id = sel.id)
WHERE ie.id = sel.id
  AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = ie.id)
  AND COALESCE(ie.system_source, '') NOT IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
  AND ie.salary_staff_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr WHERE pr.payout_voucher_id = ie.id)
  AND NOT EXISTS (SELECT 1 FROM public.approval_requests ar
                  WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ie.id
                    AND ar.system_source = 'profit.distribution');

-- C4. UNAPPROVED (pending) legacy rows → UNPOSTED / NOT_APPLICABLE, review_state PENDING (plan §6.1).
UPDATE public.income_expenses ie SET
  posting_mode   = CASE WHEN a.id IS NOT NULL AND a.is_virtual = false THEN 'CASHBOOK'  ELSE 'NON_CASH' END,
  posting_status = CASE WHEN a.id IS NOT NULL AND a.is_virtual = false THEN 'UNPOSTED'  ELSE 'NOT_APPLICABLE' END,
  review_state   = 'PENDING'
FROM (SELECT ie2.id FROM public.income_expenses ie2 WHERE ie2.approval_status = 'UNAPPROVED' AND ie2.posting_status IS NULL) sel
LEFT JOIN public.accounts a ON a.id = (SELECT account_id FROM public.income_expenses WHERE id = sel.id)
WHERE ie.id = sel.id
  AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = ie.id)
  AND COALESCE(ie.system_source, '') NOT IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
  AND ie.salary_staff_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr WHERE pr.payout_voucher_id = ie.id)
  AND NOT EXISTS (SELECT 1 FROM public.approval_requests ar
                  WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ie.id
                    AND ar.system_source = 'profit.distribution');

-- ============================================================================
-- PART D — SOURCE ALIAS NORMALIZATION (plan §8.1). Explicit VALUES mapping, guarded by
-- flow-ownership / lineage columns, with before/after NOTICE counts. Ambiguous → exception.
-- ============================================================================
DO $alias_backfill$
DECLARE
  v_before_deposit int; v_before_mgr int; v_before_staff int;
  v_after_deposit  int; v_after_mgr  int; v_after_staff  int;
BEGIN
  -- Mapping (baseline/missing → target):
  --   contract.create.v2 → contract.deposit  (proof: contract_id present)
  --   profit.manager_salary / NULL manager → salary.manager (proof: profit_manager_id present)
  --   NULL staff payout → salary.staff       (proof: salary_staff_id present & role staff)
  SELECT count(*) INTO v_before_deposit FROM public.income_expenses WHERE system_source = 'contract.create.v2';
  SELECT count(*) INTO v_before_mgr     FROM public.income_expenses WHERE system_source = 'profit.manager_salary';
  SELECT count(*) INTO v_before_staff   FROM public.income_expenses
    WHERE system_source IS NULL AND salary_staff_id IS NOT NULL AND COALESCE(salary_role, 'STAFF') <> 'MANAGER';

  UPDATE public.income_expenses ie SET system_source = map.target
  FROM (VALUES ('contract.create.v2'::text, 'contract.deposit'::text)) AS map(src, target)
  WHERE ie.system_source = map.src
    AND ie.contract_id IS NOT NULL;

  UPDATE public.income_expenses ie SET system_source = 'salary.manager'
  WHERE ie.system_source = 'profit.manager_salary'
    AND ie.profit_manager_id IS NOT NULL;

  UPDATE public.income_expenses ie SET system_source = 'salary.staff'
  WHERE ie.system_source IS NULL
    AND ie.salary_staff_id IS NOT NULL
    AND COALESCE(ie.salary_role, 'STAFF') <> 'MANAGER';

  SELECT count(*) INTO v_after_deposit FROM public.income_expenses WHERE system_source = 'contract.deposit';
  SELECT count(*) INTO v_after_mgr     FROM public.income_expenses WHERE system_source = 'salary.manager';
  SELECT count(*) INTO v_after_staff   FROM public.income_expenses WHERE system_source = 'salary.staff';

  -- Ambiguous: alias present but the lineage proof column is missing → exception, do not remap.
  INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
  SELECT ie.organization_id, ie.id, 'SOURCE_ALIAS_UNPROVEN',
         jsonb_build_object('system_source', ie.system_source, 'contract_id', ie.contract_id,
                            'profit_manager_id', ie.profit_manager_id, 'salary_staff_id', ie.salary_staff_id)
  FROM public.income_expenses ie
  WHERE (ie.system_source = 'contract.create.v2'    AND ie.contract_id IS NULL)
     OR (ie.system_source = 'profit.manager_salary' AND ie.profit_manager_id IS NULL)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Finance V2 §8.1 source alias backfill: contract.deposit +% (now %); salary.manager +% (now %); salary.staff +% (now %)',
    v_before_deposit, v_after_deposit, v_before_mgr, v_after_mgr, v_before_staff, v_after_staff;
END
$alias_backfill$;

-- ============================================================================
-- PART E — CASHBOOK POSSESSION CANDIDATE BACKFILL (plan §10.2). Never auto-materialize a binding;
-- everything lands as PENDING_REVIEW for owner disposition. Matches the existing candidate conventions
-- (ACCOUNT_OWNER/CUSTODIAN, LEGACY_SHARE/OPERATOR) and is idempotent by natural identity.
-- ============================================================================

-- E1. accounts.user_id (certain ownership possession) → CUSTODIAN candidate (PENDING_REVIEW).
INSERT INTO app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id, proposed_kind,
  source_kind, source_relation, source_row_id, source_user_id, status, evidence, version, created_at, updated_at
)
SELECT
  md5(a.organization_id::text || ':' || a.id::text || ':ACCOUNT_OWNER:' || a.user_id::text),
  a.organization_id, a.id, om.id, 'CUSTODIAN',
  'ACCOUNT_OWNER', 'accounts', a.id, a.user_id, 'PENDING_REVIEW',
  jsonb_build_object('backfill', 'stage4', 'source_created_at', a.created_at), 1, now(), now()
FROM public.accounts a
JOIN LATERAL (
  SELECT m.id FROM public.organization_memberships m
  WHERE m.organization_id = a.organization_id AND m.user_id = a.user_id AND m.status = 'ACTIVE'
  ORDER BY m.activated_at NULLS LAST, m.id LIMIT 1
) om ON true
WHERE a.deleted_at IS NULL AND a.user_id IS NOT NULL AND a.is_virtual = false
  AND NOT EXISTS (
    SELECT 1 FROM app_private.cashbook_possession_candidates c
    WHERE c.organization_id = a.organization_id AND c.cashbook_id = a.id
      AND c.source_kind = 'ACCOUNT_OWNER' AND c.source_user_id = a.user_id)
ON CONFLICT (candidate_key) DO NOTHING;

-- E1-exc. account owner whose user has no ACTIVE membership in the account's org → org mismatch.
INSERT INTO app_private.cashbook_access_v2_backfill_exceptions (organization_id, cashbook_id, membership_id, reason_code, detail)
SELECT a.organization_id, a.id, NULL, 'ACCOUNT_OWNER_NO_ACTIVE_MEMBERSHIP',
       jsonb_build_object('account_id', a.id, 'user_id', a.user_id)
FROM public.accounts a
WHERE a.deleted_at IS NULL AND a.user_id IS NOT NULL AND a.is_virtual = false
  AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.organization_id = a.organization_id AND m.user_id = a.user_id AND m.status = 'ACTIVE')
ON CONFLICT DO NOTHING;

-- E2. account_shared_users → candidate NEEDING DISPOSITION (never auto-CUSTODIAN). Tenant-consistent only.
INSERT INTO app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id, proposed_kind,
  source_kind, source_relation, source_row_id, source_user_id, status, evidence, version, created_at, updated_at
)
SELECT
  md5(a.organization_id::text || ':' || a.id::text || ':LEGACY_SHARE:' || s.user_id::text),
  a.organization_id, a.id, om.id, 'OPERATOR',
  'LEGACY_SHARE', 'account_shared_users', s.id, s.user_id, 'PENDING_REVIEW',
  jsonb_build_object('backfill', 'stage4', 'shared_by', s.created_by, 'source_created_at', s.created_at), 1, now(), now()
FROM public.account_shared_users s
JOIN public.accounts a ON a.id = s.account_id AND a.deleted_at IS NULL AND a.organization_id = s.organization_id
LEFT JOIN LATERAL (
  SELECT m.id FROM public.organization_memberships m
  WHERE m.organization_id = a.organization_id AND m.user_id = s.user_id AND m.status = 'ACTIVE'
  ORDER BY m.activated_at NULLS LAST, m.id LIMIT 1
) om ON true
WHERE NOT EXISTS (
    SELECT 1 FROM app_private.cashbook_possession_candidates c
    WHERE c.organization_id = a.organization_id AND c.cashbook_id = a.id
      AND c.source_kind = 'LEGACY_SHARE' AND c.source_user_id = s.user_id)
ON CONFLICT (candidate_key) DO NOTHING;

-- E2-exc. share whose account org differs from the share row org → cross-tenant → exception.
INSERT INTO app_private.cashbook_access_v2_backfill_exceptions (organization_id, cashbook_id, membership_id, reason_code, detail)
SELECT s.organization_id, s.account_id, NULL, 'SHARE_ORG_MISMATCH',
       jsonb_build_object('share_id', s.id, 'share_org', s.organization_id,
                          'account_org', a.organization_id, 'user_id', s.user_id)
FROM public.account_shared_users s
JOIN public.accounts a ON a.id = s.account_id
WHERE a.organization_id IS DISTINCT FROM s.organization_id
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
