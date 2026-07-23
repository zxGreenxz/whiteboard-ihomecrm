-- Finance V2 (Thu Chi V2) — Stage 2: schema-inert + activation guards.
--
-- Additive/inert schema for the whole Finance V2 program (plan §6, §10.4): posting event
-- ledger + signed lines, evidence registry, cashbook access CAS + execution routing (with
-- KNOWER widening of the 3 possession constraints), income_expenses header columns,
-- canonical_write_operations idempotency expansion, approval_requests compatibility +
-- state-check widening, recognition adjustments, profit reservation lifecycle, salary
-- settlement bundle/authorization/tranche + earning consumption, termination move-out
-- authorization/settlement lines, and the control plane: 7 Finance feature keys seeded OFF,
-- business-policy + activation-attestation authorities, backfill capture + semantic-event
-- log, and the assert_finance_v2_feature_activation_v1 / _canary_enrollment_v1 guards that
-- fail closed on any CANARY/ON transition without attestation.
--
-- Everything is nullable/inert, FKs to large existing tables are NOT VALID, new client-facing
-- tables are RLS deny-all until Stage-11. No feature mode is changed and no org is enrolled.
-- Assembled from 6 reviewed non-overlapping fragments; guards placed last.

BEGIN;

-- ========================================================================
-- STAGE 2 FRAGMENT G4 :: G4
-- ========================================================================
-- ============================================================================
-- GROUP G4 — header additions + idempotency expansion + approval compat + recognition adjustment
-- Plan: PLAN-THU-CHI-V2-DUYET-CHI-PHAN-QUYEN-SO-QUY §6.1, §6.6, §7.4
-- ============================================================================

-- §6.1 — Header additions on public.income_expenses (expand phase: additive, nullable,
-- inert defaults; NO CHECK constraints and NO approval_status default change yet).
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS posting_mode                text,
  ADD COLUMN IF NOT EXISTS posting_status              text,
  ADD COLUMN IF NOT EXISTS active_posting_id_v2        uuid,
  ADD COLUMN IF NOT EXISTS recognition_date            date,
  ADD COLUMN IF NOT EXISTS recognition_source_mode     text,
  ADD COLUMN IF NOT EXISTS review_state                text,
  ADD COLUMN IF NOT EXISTS review_owner_membership_id  uuid,
  ADD COLUMN IF NOT EXISTS review_reason               text,
  ADD COLUMN IF NOT EXISTS review_deadline             timestamptz,
  ADD COLUMN IF NOT EXISTS change_field_mask           jsonb,
  ADD COLUMN IF NOT EXISTS review_version              bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approval_version            bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS posting_version             bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cancellation_kind           text,
  ADD COLUMN IF NOT EXISTS maker_user_id               uuid,
  ADD COLUMN IF NOT EXISTS maker_membership_id         uuid,
  ADD COLUMN IF NOT EXISTS birth_operation_id          uuid,
  ADD COLUMN IF NOT EXISTS birth_txid                  xid8;

COMMENT ON COLUMN public.income_expenses.active_posting_id_v2 IS
  'Plan §6.1: server-owned pointer to the current non-reversed POSTING; NULL when UNPOSTED/REVERSED/NOT_APPLICABLE. Cross-group FK -> income_expense_postings(id) added post-assembly.';
COMMENT ON COLUMN public.income_expenses.recognition_source_mode IS
  'Plan §6.1/§6.6: BASE vs ADJUSTMENT_ONLY contract that excludes double counting once a period is closed.';
COMMENT ON COLUMN public.income_expenses.birth_txid IS
  'Plan §6.1: PostgreSQL xid8 of the create transaction that gave birth to the obligation; used by the committed-birth-boundary guard (nested create->approve/post in one txn must fail).';

-- §6.1 — canonical_write_operations version/txn/outcome expansion (server-only control plane).
-- subject_id/response_payload/created_at/completed_at already exist; do NOT touch RLS/grants.
ALTER TABLE app_private.canonical_write_operations
  ADD COLUMN IF NOT EXISTS actor_membership_id         uuid,
  ADD COLUMN IF NOT EXISTS transaction_id              xid8,
  ADD COLUMN IF NOT EXISTS expected_review_version     bigint,
  ADD COLUMN IF NOT EXISTS expected_approval_version   bigint,
  ADD COLUMN IF NOT EXISTS expected_posting_version    bigint,
  ADD COLUMN IF NOT EXISTS resulting_review_version    bigint,
  ADD COLUMN IF NOT EXISTS resulting_approval_version  bigint,
  ADD COLUMN IF NOT EXISTS resulting_posting_version   bigint,
  ADD COLUMN IF NOT EXISTS outcome_kind                text;

-- §7.4 — approval_requests outcome columns (compat expansion; do NOT touch RLS/grants).
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS outcome_kind            text,
  ADD COLUMN IF NOT EXISTS outcome_reason          text,
  ADD COLUMN IF NOT EXISTS closed_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS closed_at               timestamptz;

-- §7.4 — Widen approval_requests_state_check to add the four new terminal states
-- (APPROVED, WITHDRAWN, CHANGES_REQUESTED, DISPUTED) while keeping all existing states
-- incl. POSTED compat. Idempotent drop+recreate; superset so existing rows still satisfy it.
-- NOTE: the one-open PENDING_APPROVAL index is Stage-5 (after backfill) and is NOT created here.
DO $g4_ar_state$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'approval_requests_state_check'
      AND conrelid = 'public.approval_requests'::regclass
  ) THEN
    ALTER TABLE public.approval_requests DROP CONSTRAINT approval_requests_state_check;
  END IF;

  ALTER TABLE public.approval_requests
    ADD CONSTRAINT approval_requests_state_check
    CHECK (state = ANY (ARRAY[
      'PENDING_APPROVAL'::text, 'POSTED'::text, 'DENIED'::text, 'REJECTED'::text,
      'CANCELLED'::text, 'REVERSED'::text,
      'APPROVED'::text, 'WITHDRAWN'::text, 'CHANGES_REQUESTED'::text, 'DISPUTED'::text
    ]));
END
$g4_ar_state$;

-- §6.6 — Append-only recognition adjustments for locked periods.
CREATE TABLE IF NOT EXISTS public.income_expense_recognition_adjustments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  voucher_id                uuid NOT NULL,                          -- cross-group FK -> income_expenses(id, organization_id), added post-assembly
  original_period           date,
  adjustment_period         date NOT NULL,
  signed_amount             numeric(18,2) NOT NULL,                 -- server-computed signed delta
  allocation_snapshot       jsonb,
  adjustment_kind           text NOT NULL,
  reason                    text,
  idempotency_key           text NOT NULL,
  source_payload_hash       text,
  created_by_membership_id  uuid,
  created_by_user_id        uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  related_close_run_id      uuid,                                   -- cross-group FK -> profit_close_runs(id), added post-assembly
  related_revision_id       uuid,
  CONSTRAINT income_expense_recognition_adjustments_kind_check
    CHECK (adjustment_kind = ANY (ARRAY['LATE_RECOGNITION'::text, 'CANCELLATION'::text, 'CORRECTION'::text]))
);

COMMENT ON TABLE public.income_expense_recognition_adjustments IS
  'Plan §6.6: append-only catch-up / cancellation / correction adjustments for locked recognition periods; server-owned signed delta + allocation snapshot. Immutable (no UPDATE/DELETE); client DML revoked; RLS deny-all until Stage-11.';

-- §6.6 — same-key/different-payload conflict guard.
CREATE UNIQUE INDEX IF NOT EXISTS income_expense_recognition_adjustments_org_idem_uq
  ON public.income_expense_recognition_adjustments (organization_id, idempotency_key);

-- §6.6 — append-only immutability (block UPDATE/DELETE).
CREATE OR REPLACE FUNCTION public.income_expense_recognition_adjustments_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g4_recadj_immutable$
BEGIN
  RAISE EXCEPTION 'public.income_expense_recognition_adjustments is append-only (no UPDATE/DELETE)';
  RETURN NULL;
END
$g4_recadj_immutable$;

DROP TRIGGER IF EXISTS a00_income_expense_recognition_adjustments_immutable
  ON public.income_expense_recognition_adjustments;
CREATE TRIGGER a00_income_expense_recognition_adjustments_immutable
  BEFORE UPDATE OR DELETE ON public.income_expense_recognition_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.income_expense_recognition_adjustments_immutable();

-- §6.6 — ACL: deny-all client access until Stage-11; canonical writer may append/read only.
REVOKE ALL ON public.income_expense_recognition_adjustments FROM PUBLIC;
DO $g4_recadj_acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_recognition_adjustments FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_recognition_adjustments FROM authenticated';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_recognition_adjustments FROM service_role';
  END IF;
END
$g4_recadj_acl$;

ALTER TABLE public.income_expense_recognition_adjustments ENABLE ROW LEVEL SECURITY;
-- No RLS policy on purpose: deny-all until Stage-11.

DO $g4_recadj_writer$
BEGIN
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN
    -- Append-only: SELECT + INSERT only (immutable trigger blocks UPDATE/DELETE anyway).
    EXECUTE 'GRANT SELECT, INSERT ON public.income_expense_recognition_adjustments TO ie_canonical_writer';
  END IF;
END
$g4_recadj_writer$;

-- ========================================================================
-- STAGE 2 FRAGMENT G1 :: G1
-- ========================================================================
-- =====================================================================
-- GROUP G1 — POSTING EVENT (Finance V2 / Thu Chi V2, plan §6.2)
-- Canonical append-only accounting posting events + balanced signed lines.
-- Client-readable money surface -> schema public. Deny-all RLS until Stage-11.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §6.2 Posting event header. Append-only: a reversal is a NEW event row,
-- never an UPDATE/DELETE of the original (enforced by a00 trigger below).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.income_expense_postings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  voucher_id                uuid NULL,
  posting_subject_kind      text NOT NULL DEFAULT 'VOUCHER'
                              CHECK (posting_subject_kind IN ('VOUCHER','SALARY_TRANCHE')),
  posting_subject_id        uuid NOT NULL,
  direction                 text NOT NULL CHECK (direction IN ('INCOME','EXPENSE')),
  account_id                uuid NOT NULL,
  gross_amount              numeric(18,2) NOT NULL CHECK (gross_amount > 0),
  voucher_amount_snapshot   numeric(18,2) NOT NULL CHECK (voucher_amount_snapshot >= 0),
  amount_basis              text NOT NULL
                              CHECK (amount_basis IN ('VOUCHER_TOTAL','EXTERNAL_TENDER_GROSS','SALARY_TRANCHE_CASH')),
  net_cash_effect           numeric(18,2) NOT NULL,
  posted_on                 date NOT NULL,
  posted_by_membership_id   uuid NOT NULL,
  posted_by_user_id         uuid NOT NULL,
  approval_request_id       uuid NULL,
  approval_version          bigint NOT NULL,
  event_kind                text NOT NULL CHECK (event_kind IN ('POSTING','REVERSAL')),
  idempotency_key           text NOT NULL,
  source_kind               text NOT NULL,
  external_source_kind      text NULL,
  external_source_id        uuid NULL,
  external_source_line_id   uuid NULL,
  posting_generation        bigint NOT NULL,
  replaces_posting_id       uuid NULL,
  reversal_of_id            uuid NULL,
  source_version_or_hash    text NULL,
  evidence_waiver           text NULL,
  legacy_provenance         jsonb NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  reversal_reason           text NULL,
  -- §6.2 VOUCHER events must pin voucher_id to the subject id.
  CONSTRAINT income_expense_postings_voucher_subject_check
    CHECK (posting_subject_kind <> 'VOUCHER' OR voucher_id = posting_subject_id)
);
COMMENT ON TABLE public.income_expense_postings IS
  'Finance V2 §6.2 — canonical append-only accounting posting events (reversal = a NEW event).';

-- ACL (§ shared conventions): revoke PUBLIC + all client roles; grant the
-- unprivileged canonical writer SELECT/INSERT/UPDATE (never DELETE/TRUNCATE).
REVOKE ALL ON public.income_expense_postings FROM PUBLIC;
DO $g1_acl_postings$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_postings FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_postings FROM authenticated';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_postings FROM service_role';
  END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.income_expense_postings TO ie_canonical_writer';
  END IF;
END
$g1_acl_postings$;

-- Deny-all until Stage-11 wires read policies (§ shared conventions: no policy).
ALTER TABLE public.income_expense_postings ENABLE ROW LEVEL SECURITY;

-- §6.2 uniqueness + lookup indexes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_postings_org_idempotency
  ON public.income_expense_postings (organization_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_postings_external_source
  ON public.income_expense_postings
       (organization_id, external_source_kind, external_source_id, external_source_line_id, event_kind)
  WHERE external_source_kind IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_postings_subject_generation
  ON public.income_expense_postings
       (organization_id, posting_subject_kind, posting_subject_id, posting_generation)
  WHERE event_kind = 'POSTING';

CREATE INDEX IF NOT EXISTS ix_ie_postings_org_account_posted_on
  ON public.income_expense_postings (organization_id, account_id, posted_on);

CREATE INDEX IF NOT EXISTS ix_ie_postings_voucher
  ON public.income_expense_postings (voucher_id);

-- §6.2 self-referential lineage FKs (NOT VALID; validated in a later stage).
DO $g1_selffk_postings$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_postings_replaces'
      AND conrelid = 'public.income_expense_postings'::regclass
  ) THEN
    ALTER TABLE public.income_expense_postings
      ADD CONSTRAINT fk_ie_postings_replaces
      FOREIGN KEY (replaces_posting_id)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_postings_reversal_of'
      AND conrelid = 'public.income_expense_postings'::regclass
  ) THEN
    ALTER TABLE public.income_expense_postings
      ADD CONSTRAINT fk_ie_postings_reversal_of
      FOREIGN KEY (reversal_of_id)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
END
$g1_selffk_postings$;

-- §6.2 append-only enforcement: shared immutable trigger function (server-only).
CREATE OR REPLACE FUNCTION app_private.finance_v2_posting_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g1_immutable_fn$
BEGIN
  RAISE EXCEPTION
    'public.% is append-only (Finance V2 §6.2): posting events are immutable; a reversal is a NEW event',
    TG_TABLE_NAME;
  RETURN NULL;
END
$g1_immutable_fn$;

DROP TRIGGER IF EXISTS a00_income_expense_postings_immutable ON public.income_expense_postings;
CREATE TRIGGER a00_income_expense_postings_immutable
  BEFORE UPDATE OR DELETE ON public.income_expense_postings
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_posting_event_immutable();

-- ---------------------------------------------------------------------
-- §6.2 Posting lines: signed amounts belonging to a posting event.
-- Intra-group FK posting_id -> income_expense_postings(id) inline (same batch,
-- new small table) — validated, not NOT VALID.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.income_expense_posting_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  posting_id       uuid NOT NULL REFERENCES public.income_expense_postings(id),
  account_id       uuid NOT NULL,
  line_kind        text NOT NULL CHECK (line_kind IN ('MAIN','CHANGE','ROUNDING','REVERSAL')),
  signed_amount    numeric(18,2) NOT NULL CHECK (signed_amount <> 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.income_expense_posting_lines IS
  'Finance V2 §6.2 — signed lines of an income_expense_postings event (append-only).';

REVOKE ALL ON public.income_expense_posting_lines FROM PUBLIC;
DO $g1_acl_lines$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_posting_lines FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_posting_lines FROM authenticated';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.income_expense_posting_lines FROM service_role';
  END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.income_expense_posting_lines TO ie_canonical_writer';
  END IF;
END
$g1_acl_lines$;

ALTER TABLE public.income_expense_posting_lines ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS ix_ie_posting_lines_org_account
  ON public.income_expense_posting_lines (organization_id, account_id);

DROP TRIGGER IF EXISTS a00_income_expense_posting_lines_immutable ON public.income_expense_posting_lines;
CREATE TRIGGER a00_income_expense_posting_lines_immutable
  BEFORE UPDATE OR DELETE ON public.income_expense_posting_lines
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_posting_event_immutable();

-- ========================================================================
-- STAGE 2 FRAGMENT G2 :: G2
-- ========================================================================
-- ============================================================================
-- GROUP G2 — EVIDENCE REGISTRY (plan §6.3 "Registry chứng từ canonical")
-- Canonical evidence objects, typed system-source links, and posting<->evidence
-- attachment links. Client cannot read yet: RLS deny-all until Stage-11; only
-- ie_canonical_writer gets SELECT/INSERT/UPDATE (writer RPCs are owner-owned
-- SECURITY DEFINER and bypass RLS since RLS is not FORCEd).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) public.finance_evidence_objects — the evidence registry (§6.3, §476).
--    provenance_kind + state model UPLOAD intent -> FINALIZED -> ATTACHED /
--    QUARANTINED. Per-provenance column requirements and the one-typed-source
--    rule are enforced by the writer RPC later; schema keeps only the enum
--    domains + tenant-scoped object identity uniqueness.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_evidence_objects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  bucket_id              text NOT NULL,
  object_name            text NOT NULL,
  uploader_membership_id uuid,
  uploader_user_id       uuid,
  sha256                 text,
  byte_size              bigint,
  mime_type              text,
  provenance_kind        text NOT NULL,
  state                  text NOT NULL,
  upload_token_hash      text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  finalized_at           timestamptz,
  CONSTRAINT finance_evidence_objects_provenance_kind_check
    CHECK (provenance_kind IN ('UPLOAD','SYSTEM_REFERENCE')),
  CONSTRAINT finance_evidence_objects_state_check
    CHECK (state IN ('UPLOAD_INTENT','FINALIZED','ATTACHED','QUARANTINED'))
);

-- Defensive column patch for stale partial applies (idempotent no-op on fresh).
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS uploader_membership_id uuid;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS uploader_user_id       uuid;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS sha256                 text;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS byte_size              bigint;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS mime_type              text;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS upload_token_hash      text;
ALTER TABLE public.finance_evidence_objects ADD COLUMN IF NOT EXISTS finalized_at           timestamptz;

-- Tenant-scoped storage object identity is unique (§6.3: no path overwrite/reuse).
DO $g2_uq_objects_obj$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.finance_evidence_objects'::regclass
      AND conname = 'finance_evidence_objects_org_bucket_object_key'
  ) THEN
    ALTER TABLE public.finance_evidence_objects
      ADD CONSTRAINT finance_evidence_objects_org_bucket_object_key
      UNIQUE (organization_id, bucket_id, object_name);
  END IF;
END
$g2_uq_objects_obj$;

-- Composite (organization_id, id) unique key: FK target so intra-group links
-- can reference evidence tenant-safely (organization_id must match).
DO $g2_uq_objects_orgid$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.finance_evidence_objects'::regclass
      AND conname = 'finance_evidence_objects_org_id_key'
  ) THEN
    ALTER TABLE public.finance_evidence_objects
      ADD CONSTRAINT finance_evidence_objects_org_id_key
      UNIQUE (organization_id, id);
  END IF;
END
$g2_uq_objects_orgid$;

COMMENT ON TABLE public.finance_evidence_objects IS
  'Plan §6.3/§476: canonical evidence registry; UPLOAD vs SYSTEM_REFERENCE provenance, UPLOAD_INTENT->FINALIZED->ATTACHED/QUARANTINED lifecycle. Deny-all RLS until Stage-11.';

ALTER TABLE public.finance_evidence_objects ENABLE ROW LEVEL SECURITY;  -- §6.3 deny-all until Stage-11 (no policy added)
REVOKE ALL ON public.finance_evidence_objects FROM PUBLIC;
DO $g2_acl_objects$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_objects FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_objects FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_objects FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.finance_evidence_objects TO ie_canonical_writer'; END IF;
END
$g2_acl_objects$;

-- ---------------------------------------------------------------------------
-- 2) public.finance_evidence_system_sources — typed system-source links for
--    SYSTEM_REFERENCE evidence (§6.3, §474, §480). Polymorphic UUIDs replaced
--    by typed columns; V5 per-tender determinism enforced by a partial unique.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_evidence_system_sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id          uuid NOT NULL,
  organization_id      uuid NOT NULL,
  source_kind          text NOT NULL,
  collection_id        uuid,
  tender_id            uuid,
  payment_id           uuid,
  source_snapshot_hash text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_evidence_system_sources_source_kind_check
    CHECK (source_kind IN ('INVOICE_COLLECTION_V5','CONTRACT_V2','UTILITY','OTHER_ALLOWLISTED'))
);

ALTER TABLE public.finance_evidence_system_sources ADD COLUMN IF NOT EXISTS collection_id        uuid;
ALTER TABLE public.finance_evidence_system_sources ADD COLUMN IF NOT EXISTS tender_id            uuid;
ALTER TABLE public.finance_evidence_system_sources ADD COLUMN IF NOT EXISTS payment_id           uuid;
ALTER TABLE public.finance_evidence_system_sources ADD COLUMN IF NOT EXISTS source_snapshot_hash text;

-- Intra-group tenant-safe FK to the registry (organization_id must match).
DO $g2_fk_sources_evidence$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.finance_evidence_system_sources'::regclass
      AND conname = 'finance_evidence_system_sources_evidence_fkey'
  ) THEN
    ALTER TABLE public.finance_evidence_system_sources
      ADD CONSTRAINT finance_evidence_system_sources_evidence_fkey
      FOREIGN KEY (organization_id, evidence_id)
      REFERENCES public.finance_evidence_objects (organization_id, id);
  END IF;
END
$g2_fk_sources_evidence$;

-- §480: one deterministic SYSTEM_REFERENCE evidence per V5 tender.
CREATE UNIQUE INDEX IF NOT EXISTS finance_evidence_system_sources_v5_tender_uniq
  ON public.finance_evidence_system_sources (organization_id, source_kind, collection_id, tender_id)
  WHERE source_kind = 'INVOICE_COLLECTION_V5';

-- Lookup helper (resolve source rows by evidence).
CREATE INDEX IF NOT EXISTS finance_evidence_system_sources_evidence_idx
  ON public.finance_evidence_system_sources (organization_id, evidence_id);

COMMENT ON TABLE public.finance_evidence_system_sources IS
  'Plan §6.3/§474/§480: typed source links for SYSTEM_REFERENCE evidence; partial unique gives one deterministic evidence per V5 tender.';

ALTER TABLE public.finance_evidence_system_sources ENABLE ROW LEVEL SECURITY;  -- §6.3 deny-all until Stage-11 (no policy added)
REVOKE ALL ON public.finance_evidence_system_sources FROM PUBLIC;
DO $g2_acl_sources$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_system_sources FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_system_sources FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.finance_evidence_system_sources FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.finance_evidence_system_sources TO ie_canonical_writer'; END IF;
END
$g2_acl_sources$;

-- ---------------------------------------------------------------------------
-- 3) public.income_expense_posting_evidence — posting<->evidence attachment
--    links (§6.3, §478, §484). ORIGINAL attach is one-per-evidence (partial
--    unique); INHERITED_LEGACY_DELTA links chain to a prior generation.
--    posting_id -> income_expense_postings(id) is a cross-group FK (added by
--    orchestrator after all group tables exist).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.income_expense_posting_evidence (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  posting_id             uuid NOT NULL,
  evidence_id            uuid NOT NULL,
  relation_kind          text NOT NULL,
  inherited_from_link_id uuid,
  evidence_snapshot_hash text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT income_expense_posting_evidence_relation_kind_check
    CHECK (relation_kind IN ('ORIGINAL','INHERITED_LEGACY_DELTA'))
);

ALTER TABLE public.income_expense_posting_evidence ADD COLUMN IF NOT EXISTS inherited_from_link_id uuid;
ALTER TABLE public.income_expense_posting_evidence ADD COLUMN IF NOT EXISTS evidence_snapshot_hash text;

-- Intra-group tenant-safe FK to the registry (organization_id must match).
DO $g2_fk_links_evidence$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.income_expense_posting_evidence'::regclass
      AND conname = 'income_expense_posting_evidence_evidence_fkey'
  ) THEN
    ALTER TABLE public.income_expense_posting_evidence
      ADD CONSTRAINT income_expense_posting_evidence_evidence_fkey
      FOREIGN KEY (organization_id, evidence_id)
      REFERENCES public.finance_evidence_objects (organization_id, id);
  END IF;
END
$g2_fk_links_evidence$;

-- Self-FK: inherited link chains to the prior generation link (§484). NOT VALID
-- per spec (validated in a later stage).
DO $g2_fk_links_inherited$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.income_expense_posting_evidence'::regclass
      AND conname = 'income_expense_posting_evidence_inherited_from_fkey'
  ) THEN
    ALTER TABLE public.income_expense_posting_evidence
      ADD CONSTRAINT income_expense_posting_evidence_inherited_from_fkey
      FOREIGN KEY (inherited_from_link_id)
      REFERENCES public.income_expense_posting_evidence (id)
      NOT VALID;
  END IF;
END
$g2_fk_links_inherited$;

-- §478: one ORIGINAL attach per evidence object.
CREATE UNIQUE INDEX IF NOT EXISTS income_expense_posting_evidence_original_uniq
  ON public.income_expense_posting_evidence (evidence_id)
  WHERE relation_kind = 'ORIGINAL';

-- Lookup helpers: evidence-of-a-posting, and posting_id supports the
-- cross-group FK validation added later.
CREATE INDEX IF NOT EXISTS income_expense_posting_evidence_posting_idx
  ON public.income_expense_posting_evidence (organization_id, posting_id);
CREATE INDEX IF NOT EXISTS income_expense_posting_evidence_evidence_idx
  ON public.income_expense_posting_evidence (organization_id, evidence_id);

COMMENT ON TABLE public.income_expense_posting_evidence IS
  'Plan §6.3/§478/§484: posting<->evidence attachment links; ORIGINAL one-per-evidence, INHERITED_LEGACY_DELTA chains prior generation. Deny-all RLS until Stage-11.';

ALTER TABLE public.income_expense_posting_evidence ENABLE ROW LEVEL SECURITY;  -- §6.3 deny-all until Stage-11 (no policy added)
REVOKE ALL ON public.income_expense_posting_evidence FROM PUBLIC;
DO $g2_acl_links$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.income_expense_posting_evidence FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.income_expense_posting_evidence FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.income_expense_posting_evidence FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.income_expense_posting_evidence TO ie_canonical_writer'; END IF;
END
$g2_acl_links$;

-- ========================================================================
-- STAGE 2 FRAGMENT G3 :: G3
-- ========================================================================
-- =====================================================================
-- GROUP G3 — CASHBOOK ACCESS + EXECUTION ROUTING (plan §6.4)
-- =====================================================================

-- ---------------------------------------------------------------------
-- §6.4 KNOWER vocabulary widening #1 (EXISTING table — constraint only)
-- public.cashbook_possession_bindings_possession_kind_check: add 'KNOWER'.
-- Drop+recreate inside a DO block so re-apply always ends widened; every
-- existing row is CUSTODIAN/OPERATOR so the widened CHECK validates cleanly.
-- ---------------------------------------------------------------------
DO $g3_kw1$
BEGIN
  ALTER TABLE public.cashbook_possession_bindings
    DROP CONSTRAINT IF EXISTS cashbook_possession_bindings_possession_kind_check;
  ALTER TABLE public.cashbook_possession_bindings
    ADD CONSTRAINT cashbook_possession_bindings_possession_kind_check
    CHECK ((possession_kind = ANY (ARRAY['CUSTODIAN'::text, 'OPERATOR'::text, 'KNOWER'::text])));
END
$g3_kw1$;

-- ---------------------------------------------------------------------
-- §6.4 KNOWER vocabulary widening #2 (EXISTING table — constraint only)
-- app_private.cashbook_possession_candidates_proposed_kind_check: add 'KNOWER'.
-- ---------------------------------------------------------------------
DO $g3_kw2$
BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates
    DROP CONSTRAINT IF EXISTS cashbook_possession_candidates_proposed_kind_check;
  ALTER TABLE app_private.cashbook_possession_candidates
    ADD CONSTRAINT cashbook_possession_candidates_proposed_kind_check
    CHECK ((proposed_kind = ANY (ARRAY['CUSTODIAN'::text, 'OPERATOR'::text, 'KNOWER'::text])));
END
$g3_kw2$;

-- ---------------------------------------------------------------------
-- §6.4 KNOWER vocabulary widening #3 (EXISTING table — constraint only)
-- public.permission_definitions_possession_contract_check: extend the
-- accepted_possession_kinds subset domain to include 'KNOWER'. Rest of the
-- contract predicate preserved EXACTLY.
-- ---------------------------------------------------------------------
DO $g3_kw3$
BEGIN
  ALTER TABLE public.permission_definitions
    DROP CONSTRAINT IF EXISTS permission_definitions_possession_contract_check;
  ALTER TABLE public.permission_definitions
    ADD CONSTRAINT permission_definitions_possession_contract_check
    CHECK ((((NOT requires_cashbook_possession) AND (cardinality(accepted_possession_kinds) = 0)) OR (requires_cashbook_possession AND ('CASHBOOK'::text = ANY (scope_kinds)) AND (cardinality(accepted_possession_kinds) > 0) AND (accepted_possession_kinds <@ ARRAY['CUSTODIAN'::text, 'OPERATOR'::text, 'KNOWER'::text]))));
END
$g3_kw3$;

-- ---------------------------------------------------------------------
-- §6.4 cashbook access-state register (app_private; owner-only routing/CAS).
-- One revision-tracked access-state row per (org, cashbook). Server-only;
-- clients mutate exclusively via CAS RPC with expectedRevision + idempotency.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.cashbook_access_states (
  organization_id uuid        NOT NULL,
  cashbook_id     uuid        NOT NULL,
  revision        bigint      NOT NULL DEFAULT 0,
  updated_by      uuid        NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, cashbook_id)
);

REVOKE ALL ON app_private.cashbook_access_states FROM PUBLIC;
DO $g3_acl1$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_states FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_states FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_states FROM service_role'; END IF;
END
$g3_acl1$;

-- ---------------------------------------------------------------------
-- §6.4 cashbook access mutation idempotency ledger (app_private; owner-only).
-- Dedupes CAS share/revoke mutations by (org, idempotency_key); records the
-- expected/resulting revision and a replayable result snapshot.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.cashbook_access_mutation_requests (
  organization_id     uuid        NOT NULL,
  idempotency_key     text        NOT NULL,
  payload_hash        text        NOT NULL,
  expected_revision   bigint      NULL,
  resulting_revision  bigint      NULL,
  actor_membership_id uuid        NULL,
  result_snapshot     jsonb       NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key)
);

REVOKE ALL ON app_private.cashbook_access_mutation_requests FROM PUBLIC;
DO $g3_acl2$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_mutation_requests FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_mutation_requests FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.cashbook_access_mutation_requests FROM service_role'; END IF;
END
$g3_acl2$;

-- ---------------------------------------------------------------------
-- §6.4 finance execution scope (app_private; owner-only execution routing).
-- One open scope per execution subject (voucher / salary authorization);
-- carries assignment state, claim lease, and source-policy provenance.
-- Soft FKs (assigned_cashbook_id -> public.accounts, parent_voucher_id ->
-- public.income_expenses) added NOT VALID below (validated in a later stage).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.finance_execution_scopes (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL,
  execution_subject_kind   text        NOT NULL CHECK (execution_subject_kind = ANY (ARRAY['VOUCHER'::text, 'SALARY_AUTHORIZATION'::text])),
  execution_subject_id     uuid        NOT NULL,
  parent_voucher_id        uuid        NULL,
  source_scope_kind        text        NULL,
  source_scope_id          uuid        NULL,
  state                    text        NOT NULL DEFAULT 'UNASSIGNED' CHECK (state = ANY (ARRAY['UNASSIGNED'::text, 'ASSIGNED'::text, 'POSTED'::text, 'CANCELLED'::text])),
  assigned_cashbook_id     uuid        NULL,
  revision                 bigint      NOT NULL DEFAULT 0,
  source_policy_version    text        NULL,
  source_policy_hash       text        NULL,
  claimed_by_membership_id uuid        NULL,
  claim_expires_at         timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- One open (non-cancelled) scope per subject.
CREATE UNIQUE INDEX IF NOT EXISTS finance_execution_scopes_open_subject_uq
  ON app_private.finance_execution_scopes (organization_id, execution_subject_kind, execution_subject_id)
  WHERE state <> 'CANCELLED';

-- Soft FK: assigned cashbook -> public.accounts(id) (NOT VALID; validate later).
DO $g3_fk_cashbook$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'finance_execution_scopes_assigned_cashbook_fk'
      AND conrelid = 'app_private.finance_execution_scopes'::regclass
  ) THEN
    ALTER TABLE app_private.finance_execution_scopes
      ADD CONSTRAINT finance_execution_scopes_assigned_cashbook_fk
      FOREIGN KEY (assigned_cashbook_id) REFERENCES public.accounts(id) NOT VALID;
  END IF;
END
$g3_fk_cashbook$;

-- Soft FK: parent voucher -> public.income_expenses(id) (NOT VALID; validate later).
DO $g3_fk_voucher$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'finance_execution_scopes_parent_voucher_fk'
      AND conrelid = 'app_private.finance_execution_scopes'::regclass
  ) THEN
    ALTER TABLE app_private.finance_execution_scopes
      ADD CONSTRAINT finance_execution_scopes_parent_voucher_fk
      FOREIGN KEY (parent_voucher_id) REFERENCES public.income_expenses(id) NOT VALID;
  END IF;
END
$g3_fk_voucher$;

REVOKE ALL ON app_private.finance_execution_scopes FROM PUBLIC;
DO $g3_acl3$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_scopes FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_scopes FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_scopes FROM service_role'; END IF;
END
$g3_acl3$;

-- ---------------------------------------------------------------------
-- §6.4 finance execution cashbook candidates (app_private; owner-only).
-- Candidate cashbooks resolved for an execution scope; intra-group FK to
-- finance_execution_scopes(id). One candidate row per (scope, cashbook).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.finance_execution_cashbook_candidates (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL,
  execution_scope_id uuid        NOT NULL,
  cashbook_id        uuid        NOT NULL,
  source_kind        text        NULL,
  source_hash        text        NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_execution_cashbook_candidates_scope_cashbook_uq
  ON app_private.finance_execution_cashbook_candidates (execution_scope_id, cashbook_id);

-- Intra-group FK: candidate -> its execution scope (validated; both tables new).
DO $g3_fk_scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'finance_execution_cashbook_candidates_scope_fk'
      AND conrelid = 'app_private.finance_execution_cashbook_candidates'::regclass
  ) THEN
    ALTER TABLE app_private.finance_execution_cashbook_candidates
      ADD CONSTRAINT finance_execution_cashbook_candidates_scope_fk
      FOREIGN KEY (execution_scope_id) REFERENCES app_private.finance_execution_scopes(id) ON DELETE CASCADE;
  END IF;
END
$g3_fk_scope$;

REVOKE ALL ON app_private.finance_execution_cashbook_candidates FROM PUBLIC;
DO $g3_acl4$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_cashbook_candidates FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_cashbook_candidates FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_execution_cashbook_candidates FROM service_role'; END IF;
END
$g3_acl4$;

-- ========================================================================
-- STAGE 2 FRAGMENT G5 :: G5
-- ========================================================================
-- =========================================================================
-- GROUP G5: reservation lifecycle + salary settlement bundle + termination
-- move-out (plan §6.7, §6.9, §6.10, §6.11). NO BEGIN/COMMIT (orchestrator wraps).
-- =========================================================================

-- §6.7 Reservation lifecycle state machine columns on the EXISTING table.
-- New columns are nullable with inert defaults only (no NOT NULL, no rewrite);
-- NOT NULL tightening + posting FKs happen in a later stage. RLS/grants on this
-- existing table are intentionally untouched.
ALTER TABLE public.profit_payout_reservations
  ADD COLUMN IF NOT EXISTS reservation_state text
    CHECK (reservation_state IN ('HELD','CONSUMED','RELEASED','REVERSED')),
  ADD COLUMN IF NOT EXISTS state_version bigint DEFAULT 1,
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_reason text,
  ADD COLUMN IF NOT EXISTS consumed_posting_id uuid,
  ADD COLUMN IF NOT EXISTS reversed_posting_id uuid;

-- =========================================================================
-- §6.10 Salary settlement bundle: the approved cash + rent-offset plan snapshot.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.salary_settlement_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  staff_id uuid,
  salary_period date,
  source_revision text,
  parent_voucher_id uuid,        -- cross-group FK -> public.income_expenses (added later, NOT VALID)
  policy_kind text CHECK (policy_kind IN ('ONE_SHOT','MULTI_TRANCHE')),
  policy_version text,
  cash_due numeric(18,2),
  planned_rent_offset numeric(18,2),
  snapshot jsonb,
  snapshot_hash text,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','APPROVED','SUPERSEDED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS salary_settlement_bundles_identity_uidx
  ON public.salary_settlement_bundles
  (organization_id, staff_id, salary_period, source_revision);

REVOKE ALL ON public.salary_settlement_bundles FROM PUBLIC;
DO $acl_ssb$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_bundles FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_bundles FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_bundles FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.salary_settlement_bundles TO ie_canonical_writer'; END IF;
END
$acl_ssb$;
ALTER TABLE public.salary_settlement_bundles ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- §6.10 MULTI_TRANCHE cash ceiling: exactly one authorization row per bundle.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.salary_cash_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  ceiling_amount numeric(18,2) NOT NULL CHECK (ceiling_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $fk_sca_bundle$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'salary_cash_authorizations_bundle_fk'
      AND conrelid = 'public.salary_cash_authorizations'::regclass
  ) THEN
    ALTER TABLE public.salary_cash_authorizations
      ADD CONSTRAINT salary_cash_authorizations_bundle_fk
      FOREIGN KEY (bundle_id) REFERENCES public.salary_settlement_bundles(id);
  END IF;
END
$fk_sca_bundle$;

CREATE UNIQUE INDEX IF NOT EXISTS salary_cash_authorizations_bundle_uidx
  ON public.salary_cash_authorizations (bundle_id);

REVOKE ALL ON public.salary_cash_authorizations FROM PUBLIC;
DO $acl_sca$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_cash_authorizations FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_cash_authorizations FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_cash_authorizations FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.salary_cash_authorizations TO ie_canonical_writer'; END IF;
END
$acl_sca$;
ALTER TABLE public.salary_cash_authorizations ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- §6.10 Append-only execution log of cash tranches. State transitions
-- (PENDING->POSTED->REVERSED) happen via UPDATE, so this is append-only in the
-- no-DELETE sense (writer holds no DELETE grant); not immutable.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.salary_settlement_tranches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  sequence integer NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  account_id uuid,
  posted_on date,
  active_posting_id uuid,        -- cross-group FK -> public.income_expense_postings (added later, NOT VALID)
  tranche_state text NOT NULL DEFAULT 'PENDING'
    CHECK (tranche_state IN ('PENDING','POSTED','REVERSED')),
  state_version bigint NOT NULL DEFAULT 1,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $fk_sst_bundle$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'salary_settlement_tranches_bundle_fk'
      AND conrelid = 'public.salary_settlement_tranches'::regclass
  ) THEN
    ALTER TABLE public.salary_settlement_tranches
      ADD CONSTRAINT salary_settlement_tranches_bundle_fk
      FOREIGN KEY (bundle_id) REFERENCES public.salary_settlement_bundles(id);
  END IF;
END
$fk_sst_bundle$;

CREATE UNIQUE INDEX IF NOT EXISTS salary_settlement_tranches_bundle_seq_uidx
  ON public.salary_settlement_tranches (bundle_id, sequence);

REVOKE ALL ON public.salary_settlement_tranches FROM PUBLIC;
DO $acl_sst$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_tranches FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_tranches FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_settlement_tranches FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.salary_settlement_tranches TO ie_canonical_writer'; END IF;
END
$acl_sst$;
ALTER TABLE public.salary_settlement_tranches ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- §6.11 Earning-source consumption ledger. source_kind/source_id is a TYPED
-- SOFT reference to a polymorphic earning source (no hard FK). Partial unique
-- guarantees at most one live (non-RELEASED) consumer per source.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.salary_earning_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  consumption_state text NOT NULL DEFAULT 'HELD'
    CHECK (consumption_state IN ('HELD','CONSUMED','RELEASED','CLAWED_BACK')),
  state_version bigint NOT NULL DEFAULT 1,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $fk_sec_bundle$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'salary_earning_consumptions_bundle_fk'
      AND conrelid = 'public.salary_earning_consumptions'::regclass
  ) THEN
    ALTER TABLE public.salary_earning_consumptions
      ADD CONSTRAINT salary_earning_consumptions_bundle_fk
      FOREIGN KEY (bundle_id) REFERENCES public.salary_settlement_bundles(id);
  END IF;
END
$fk_sec_bundle$;

CREATE UNIQUE INDEX IF NOT EXISTS salary_earning_consumptions_live_source_uidx
  ON public.salary_earning_consumptions (organization_id, source_kind, source_id)
  WHERE consumption_state <> 'RELEASED';

CREATE INDEX IF NOT EXISTS salary_earning_consumptions_bundle_idx
  ON public.salary_earning_consumptions (bundle_id);

REVOKE ALL ON public.salary_earning_consumptions FROM PUBLIC;
DO $acl_sec$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_earning_consumptions FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_earning_consumptions FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.salary_earning_consumptions FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.salary_earning_consumptions TO ie_canonical_writer'; END IF;
END
$acl_sec$;
ALTER TABLE public.salary_earning_consumptions ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- §6.9 Termination move-out revenue/offset voucher pair authorization.
-- One live authorization per termination.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.termination_move_out_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  contract_id uuid,
  termination_id uuid,
  pair_version bigint NOT NULL DEFAULT 1,
  revenue_voucher_id uuid,       -- cross-group FK -> public.income_expenses (added later, NOT VALID)
  offset_voucher_id uuid,        -- cross-group FK -> public.income_expenses (added later, NOT VALID)
  approval_request_id uuid,
  source_hash text,
  state text NOT NULL DEFAULT 'PLANNED'
    CHECK (state IN ('PLANNED','APPROVED','REVERSED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS termination_move_out_authorizations_termination_uidx
  ON public.termination_move_out_authorizations (organization_id, termination_id)
  WHERE termination_id IS NOT NULL;

REVOKE ALL ON public.termination_move_out_authorizations FROM PUBLIC;
DO $acl_tma$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_authorizations FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_authorizations FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_authorizations FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.termination_move_out_authorizations TO ie_canonical_writer'; END IF;
END
$acl_tma$;
ALTER TABLE public.termination_move_out_authorizations ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- §6.9 Settlement funding lines for a move-out authorization. funding_kind is
-- restricted to DEPOSIT_OFFSET / CUSTOMER_CREDIT (CASH_DUE excluded per §655).
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.termination_move_out_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  invoice_id uuid,
  amount numeric(18,2) NOT NULL,
  funding_kind text NOT NULL CHECK (funding_kind IN ('DEPOSIT_OFFSET','CUSTOMER_CREDIT')),
  source_hash text,
  materialized_payment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $fk_tmsl_auth$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'termination_move_out_settlement_lines_authorization_fk'
      AND conrelid = 'public.termination_move_out_settlement_lines'::regclass
  ) THEN
    ALTER TABLE public.termination_move_out_settlement_lines
      ADD CONSTRAINT termination_move_out_settlement_lines_authorization_fk
      FOREIGN KEY (authorization_id)
      REFERENCES public.termination_move_out_authorizations(id);
  END IF;
END
$fk_tmsl_auth$;

CREATE INDEX IF NOT EXISTS termination_move_out_settlement_lines_authorization_idx
  ON public.termination_move_out_settlement_lines (authorization_id);

REVOKE ALL ON public.termination_move_out_settlement_lines FROM PUBLIC;
DO $acl_tmsl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_settlement_lines FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_settlement_lines FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.termination_move_out_settlement_lines FROM service_role'; END IF;
  IF to_regrole('ie_canonical_writer') IS NOT NULL THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.termination_move_out_settlement_lines TO ie_canonical_writer'; END IF;
END
$acl_tmsl$;
ALTER TABLE public.termination_move_out_settlement_lines ENABLE ROW LEVEL SECURITY;

-- ========================================================================
-- STAGE 2 FRAGMENT G6 :: G6
-- ========================================================================
-- =====================================================================
-- Group G6 — Control plane seeds + backfill capture + semantic log
-- Plan §10.4 (activation gate / policy / attestation / semantic log) and
-- §10.0 (backfill run + change capture). No BEGIN/COMMIT (orchestrator wraps).
-- All objects app_private, owner-only.
-- =====================================================================

-- 1) §10.4 — Seed the 7 Finance V2 feature keys as OFF (fail-closed until Stage-11).
--    Mirrors app_private.server_feature_flags NOT-NULL shape from PS05: feature_key
--    and domain have no default (provided explicitly); risk_class/mode set explicitly;
--    config_version/force_freeze/caps carry their column defaults.
INSERT INTO app_private.server_feature_flags (feature_key, domain, risk_class, mode, reason)
VALUES
  ('income_expense.workflow.v2', 'income_expense', 'MONEY', 'OFF',
   'V2 income/expense approval workflow (§10.4)'),
  ('income_expense.posting.v2', 'income_expense', 'MONEY', 'OFF',
   'V2 double-entry posting engine (§10.4)'),
  ('cashbook.access.v2', 'cashbook', 'MONEY', 'OFF',
   'V2 cashbook possession/access routing (§10.4)'),
  ('income_expense.profit_close.v2', 'income_expense', 'MONEY', 'OFF',
   'V2 profit-close / period recognition (§10.4)'),
  ('income_expense.read_semantics.v2', 'income_expense', 'MONEY', 'OFF',
   'V2 canonical read semantics (§10.4)'),
  ('contract.commission.settlement.v2', 'contracts', 'MONEY', 'OFF',
   'V2 contract commission settlement (§10.4)'),
  ('salary.settlement.v2', 'salary', 'MONEY', 'OFF',
   'V2 salary settlement bundle/tranche (§10.4)')
ON CONFLICT (feature_key) DO NOTHING;

-- Shared append-only / immutable guard for the four Finance V2 ledger tables
-- (§10.4 policy + attestation, §10.0 change log, §10.4 semantic log).
CREATE OR REPLACE FUNCTION app_private.guard_finance_v2_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION 'finance V2 ledger row is append-only / immutable'
    USING ERRCODE = '55000';
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.guard_finance_v2_ledger_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.guard_finance_v2_ledger_immutable() IS
  'Blocks UPDATE/DELETE on Finance V2 append-only ledgers (§10.4/§10.0).';

-- 2) §10.4 — Immutable per-org business-policy decisions (commission/salary gating input).
CREATE TABLE IF NOT EXISTS app_private.finance_business_policy_decisions (
  organization_id uuid NOT NULL,
  policy_key text NOT NULL,
  policy_version text NOT NULL,
  payload jsonb NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_business_policy_decisions_pkey
    PRIMARY KEY (organization_id, policy_key, policy_version)
);
REVOKE ALL ON app_private.finance_business_policy_decisions FROM PUBLIC;
DO $acl$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_business_policy_decisions FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_business_policy_decisions FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_business_policy_decisions FROM service_role;
  END IF;
END $acl$;
DROP TRIGGER IF EXISTS a00_finance_business_policy_decisions_immutable
  ON app_private.finance_business_policy_decisions;
CREATE TRIGGER a00_finance_business_policy_decisions_immutable
BEFORE UPDATE OR DELETE ON app_private.finance_business_policy_decisions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_ledger_immutable();
COMMENT ON TABLE app_private.finance_business_policy_decisions IS
  '§10.4 immutable business-policy decisions required before commission/salary V2 activation.';

-- 3) §10.4 — Immutable activation attestations (gate snapshot per feature/config/org).
CREATE TABLE IF NOT EXISTS app_private.finance_v2_activation_attestations (
  feature_key text NOT NULL,
  config_version bigint NOT NULL,
  organization_id uuid,
  gate_snapshot jsonb NOT NULL,
  release_digest text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Enforce "coalesce(organization_id, zero-uuid)" identity via NULLS NOT DISTINCT (PG15+).
CREATE UNIQUE INDEX IF NOT EXISTS finance_v2_activation_attestations_identity_key
  ON app_private.finance_v2_activation_attestations
  (feature_key, config_version, organization_id) NULLS NOT DISTINCT;
REVOKE ALL ON app_private.finance_v2_activation_attestations FROM PUBLIC;
DO $acl$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_activation_attestations FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_activation_attestations FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_activation_attestations FROM service_role;
  END IF;
END $acl$;
DROP TRIGGER IF EXISTS a00_finance_v2_activation_attestations_immutable
  ON app_private.finance_v2_activation_attestations;
CREATE TRIGGER a00_finance_v2_activation_attestations_immutable
BEFORE UPDATE OR DELETE ON app_private.finance_v2_activation_attestations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_ledger_immutable();
COMMENT ON TABLE app_private.finance_v2_activation_attestations IS
  '§10.4 immutable gate attestations; NULL organization_id = global attestation.';

-- 4) §10.0 — Backfill run headers (MUTABLE lifecycle: watermarks + write barrier).
CREATE TABLE IF NOT EXISTS app_private.finance_v2_backfill_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  source_snapshot_at timestamptz,
  initial_watermark bigint,
  applied_watermark bigint,
  final_watermark bigint,
  state text NOT NULL DEFAULT 'PENDING',
  write_barrier_state text,
  barrier_token text,
  started_at timestamptz,
  completed_at timestamptz
);
REVOKE ALL ON app_private.finance_v2_backfill_runs FROM PUBLIC;
DO $acl$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_runs FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_runs FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_runs FROM service_role;
  END IF;
END $acl$;
COMMENT ON TABLE app_private.finance_v2_backfill_runs IS
  '§10.0 backfill run headers; mutable state machine + write-barrier tracking.';

-- 5) §10.0 — Append-only backfill change-capture log.
CREATE TABLE IF NOT EXISTS app_private.finance_v2_backfill_change_log (
  sequence_id bigserial PRIMARY KEY,
  organization_id uuid,
  source_table text NOT NULL,
  source_pk uuid,
  operation text NOT NULL,
  source_version_or_hash text,
  txid xid8,
  changed_at timestamptz NOT NULL DEFAULT now(),
  applied_run_id uuid REFERENCES app_private.finance_v2_backfill_runs(run_id),
  applied_at timestamptz,
  CONSTRAINT finance_v2_backfill_change_log_operation_check
    CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE'))
);
REVOKE ALL ON app_private.finance_v2_backfill_change_log FROM PUBLIC;
DO $acl$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_change_log FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_change_log FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_backfill_change_log FROM service_role;
  END IF;
END $acl$;
DROP TRIGGER IF EXISTS a00_finance_v2_backfill_change_log_immutable
  ON app_private.finance_v2_backfill_change_log;
CREATE TRIGGER a00_finance_v2_backfill_change_log_immutable
BEFORE UPDATE OR DELETE ON app_private.finance_v2_backfill_change_log
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_ledger_immutable();
COMMENT ON TABLE app_private.finance_v2_backfill_change_log IS
  '§10.0 append-only change-capture log for the V2 backfill snapshot->tail bridge.';

-- 6) §10.4 — Append-only semantic event log (BACKFILL vs V2_WRITE provenance).
CREATE TABLE IF NOT EXISTS app_private.finance_v2_semantic_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  event_kind text NOT NULL,
  source_table text,
  source_id uuid,
  source_kind text NOT NULL,
  actor uuid,
  txid xid8,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_v2_semantic_event_log_source_kind_check
    CHECK (source_kind IN ('BACKFILL', 'V2_WRITE'))
);
REVOKE ALL ON app_private.finance_v2_semantic_event_log FROM PUBLIC;
DO $acl$ BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_semantic_event_log FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_semantic_event_log FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.finance_v2_semantic_event_log FROM service_role;
  END IF;
END $acl$;
DROP TRIGGER IF EXISTS a00_finance_v2_semantic_event_log_immutable
  ON app_private.finance_v2_semantic_event_log;
CREATE TRIGGER a00_finance_v2_semantic_event_log_immutable
BEFORE UPDATE OR DELETE ON app_private.finance_v2_semantic_event_log
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_ledger_immutable();
COMMENT ON TABLE app_private.finance_v2_semantic_event_log IS
  '§10.4 append-only semantic event log distinguishing backfill vs V2-write provenance.';

-- 7) §10.0 — Change-capture trigger FUNCTION. NOT attached to any source table here;
--    Stage-4 attaches it. Appends one append-only change-log row per DML event.
CREATE OR REPLACE FUNCTION app_private.finance_v2_capture_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_row record;
  v_json jsonb;
  v_pk uuid;
  v_org uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  v_json := to_jsonb(v_row);

  BEGIN
    v_pk := (v_json ->> 'id')::uuid;
  EXCEPTION WHEN others THEN
    v_pk := NULL;
  END;
  BEGIN
    v_org := (v_json ->> 'organization_id')::uuid;
  EXCEPTION WHEN others THEN
    v_org := NULL;
  END;

  INSERT INTO app_private.finance_v2_backfill_change_log (
    organization_id, source_table, source_pk, operation,
    source_version_or_hash, txid, changed_at
  ) VALUES (
    v_org,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    v_pk,
    TG_OP,
    COALESCE(v_json ->> 'updated_at', v_json ->> 'content_hash'),
    pg_current_xact_id(),
    clock_timestamp()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.finance_v2_capture_change()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_capture_change() IS
  '§10.0 change-capture trigger fn; attach to source tables in Stage-4 (NOT attached here).';

-- ========================================================================
-- CROSS-GROUP FOREIGN KEYS (NOT VALID; validated in a later stage)
-- ========================================================================
-- §6.2 postings.voucher_id -> existing large table public.income_expenses(id) (single-col PK). Added NOT VALID after all tables exist; validated in a later stage. Idempotent-guarded.
DO $g1_fk_voucher$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_postings_voucher'
      AND conrelid = 'public.income_expense_postings'::regclass
  ) THEN
    ALTER TABLE public.income_expense_postings
      ADD CONSTRAINT fk_ie_postings_voucher
      FOREIGN KEY (voucher_id) REFERENCES public.income_expenses(id) NOT VALID;
  END IF;
END
$g1_fk_voucher$;
-- §6.2 postings.account_id -> existing table public.accounts(id) (single-col PK). NOT VALID, guarded, added after tables exist.
DO $g1_fk_postings_account$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_postings_account'
      AND conrelid = 'public.income_expense_postings'::regclass
  ) THEN
    ALTER TABLE public.income_expense_postings
      ADD CONSTRAINT fk_ie_postings_account
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) NOT VALID;
  END IF;
END
$g1_fk_postings_account$;
-- §6.2 posting_lines.account_id -> existing table public.accounts(id) (both tables carry an account_id FK per G1 spec). NOT VALID, guarded.
DO $g1_fk_lines_account$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_posting_lines_account'
      AND conrelid = 'public.income_expense_posting_lines'::regclass
  ) THEN
    ALTER TABLE public.income_expense_posting_lines
      ADD CONSTRAINT fk_ie_posting_lines_account
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) NOT VALID;
  END IF;
END
$g1_fk_lines_account$;
-- §6.2 postings.approval_request_id -> existing control-plane table public.approval_requests(id) (single-col PK). NOT VALID, guarded, added after tables exist.
DO $g1_fk_approval$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_ie_postings_approval_request'
      AND conrelid = 'public.income_expense_postings'::regclass
  ) THEN
    ALTER TABLE public.income_expense_postings
      ADD CONSTRAINT fk_ie_postings_approval_request
      FOREIGN KEY (approval_request_id) REFERENCES public.approval_requests(id) NOT VALID;
  END IF;
END
$g1_fk_approval$;
-- income_expense_posting_evidence.posting_id references public.income_expense_postings(id), a table owned by group G1. Added after all group tables exist, NOT VALID (validated in a later stage), and DO-guarded so re-apply never errors.
DO $g2_xfk_posting$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.income_expense_posting_evidence'::regclass
      AND conname = 'income_expense_posting_evidence_posting_fkey'
  ) THEN
    ALTER TABLE public.income_expense_posting_evidence
      ADD CONSTRAINT income_expense_posting_evidence_posting_fkey
      FOREIGN KEY (posting_id)
      REFERENCES public.income_expense_postings (id)
      NOT VALID;
  END IF;
END
$g2_xfk_posting$;
-- Plan §6.1/§6.4: income_expenses.active_posting_id_v2 points at the current non-reversed POSTING. income_expense_postings is created by another group (G-postings), so this FK must be assembled after that table exists. NOT VALID because income_expenses is a large existing table (validate in a later stage).
DO $g4_fk_active_posting$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'income_expenses_active_posting_id_v2_fkey'
      AND conrelid = 'public.income_expenses'::regclass
  ) THEN
    ALTER TABLE public.income_expenses
      ADD CONSTRAINT income_expenses_active_posting_id_v2_fkey
      FOREIGN KEY (active_posting_id_v2)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
END
$g4_fk_active_posting$;
-- Plan §6.6: adjustment must reference its voucher within the same tenant. Implemented as the plan-mandated composite (voucher_id, organization_id) FK against the existing unique index income_expenses_id_org_uq (id, organization_id) rather than the single-column shorthand, per the shared convention preferring a composite FK when the target has a matching unique key. income_expenses is a large existing table -> NOT VALID. Deferred so it lands after all tables exist.
DO $g4_fk_voucher$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'income_expense_recognition_adjustments_voucher_fkey'
      AND conrelid = 'public.income_expense_recognition_adjustments'::regclass
  ) THEN
    ALTER TABLE public.income_expense_recognition_adjustments
      ADD CONSTRAINT income_expense_recognition_adjustments_voucher_fkey
      FOREIGN KEY (voucher_id, organization_id)
      REFERENCES public.income_expenses(id, organization_id) NOT VALID;
  END IF;
END
$g4_fk_voucher$;
-- Plan §6.6: adjustment links back to the profit close run that locked the source period. profit_close_runs is owned by the profit-close group; single-column FK to id NOT VALID (organization_id kept on the row for tenant scoping). Deferred so it lands after profit_close_runs exists.
DO $g4_fk_close_run$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'income_expense_recognition_adjustments_close_run_fkey'
      AND conrelid = 'public.income_expense_recognition_adjustments'::regclass
  ) THEN
    ALTER TABLE public.income_expense_recognition_adjustments
      ADD CONSTRAINT income_expense_recognition_adjustments_close_run_fkey
      FOREIGN KEY (related_close_run_id)
      REFERENCES public.profit_close_runs(id) NOT VALID;
  END IF;
END
$g4_fk_close_run$;
-- §6.10 salary tranche active_posting_id references the posting produced when the tranche is executed; income_expense_postings is owned by another group in this batch, so the FK is authored NOT VALID after all tables exist.
DO $xfk_sst_posting$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'salary_settlement_tranches_active_posting_fk'
      AND conrelid = 'public.salary_settlement_tranches'::regclass) THEN
    ALTER TABLE public.salary_settlement_tranches
      ADD CONSTRAINT salary_settlement_tranches_active_posting_fk
      FOREIGN KEY (active_posting_id)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
END
$xfk_sst_posting$;
-- §6.7 reservation CONSUMED transition links to the posting that consumed the hold; income_expense_postings belongs to another group, so NOT VALID and added after tables exist. Existing reservation rows have NULL here so validation is a no-op.
DO $xfk_ppr_consumed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profit_payout_reservations_consumed_posting_fk'
      AND conrelid = 'public.profit_payout_reservations'::regclass) THEN
    ALTER TABLE public.profit_payout_reservations
      ADD CONSTRAINT profit_payout_reservations_consumed_posting_fk
      FOREIGN KEY (consumed_posting_id)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
END
$xfk_ppr_consumed$;
-- §6.7 reservation REVERSED transition links to the reversing posting; income_expense_postings belongs to another group, so NOT VALID and added after tables exist.
DO $xfk_ppr_reversed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profit_payout_reservations_reversed_posting_fk'
      AND conrelid = 'public.profit_payout_reservations'::regclass) THEN
    ALTER TABLE public.profit_payout_reservations
      ADD CONSTRAINT profit_payout_reservations_reversed_posting_fk
      FOREIGN KEY (reversed_posting_id)
      REFERENCES public.income_expense_postings(id) NOT VALID;
  END IF;
END
$xfk_ppr_reversed$;
-- §6.10 salary bundle parent_voucher_id references the originating salary voucher in income_expenses (large existing table); added NOT VALID to avoid a full scan, validated in a later stage.
DO $xfk_ssb_parent$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'salary_settlement_bundles_parent_voucher_fk'
      AND conrelid = 'public.salary_settlement_bundles'::regclass) THEN
    ALTER TABLE public.salary_settlement_bundles
      ADD CONSTRAINT salary_settlement_bundles_parent_voucher_fk
      FOREIGN KEY (parent_voucher_id)
      REFERENCES public.income_expenses(id) NOT VALID;
  END IF;
END
$xfk_ssb_parent$;
-- §6.9 move-out revenue_voucher_id references the revenue side voucher in income_expenses (large existing table); added NOT VALID to avoid a full scan, validated in a later stage.
DO $xfk_tma_revenue$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'termination_move_out_authorizations_revenue_voucher_fk'
      AND conrelid = 'public.termination_move_out_authorizations'::regclass) THEN
    ALTER TABLE public.termination_move_out_authorizations
      ADD CONSTRAINT termination_move_out_authorizations_revenue_voucher_fk
      FOREIGN KEY (revenue_voucher_id)
      REFERENCES public.income_expenses(id) NOT VALID;
  END IF;
END
$xfk_tma_revenue$;
-- §6.9 move-out offset_voucher_id references the deposit/credit offset voucher in income_expenses (large existing table); added NOT VALID to avoid a full scan, validated in a later stage.
DO $xfk_tma_offset$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'termination_move_out_authorizations_offset_voucher_fk'
      AND conrelid = 'public.termination_move_out_authorizations'::regclass) THEN
    ALTER TABLE public.termination_move_out_authorizations
      ADD CONSTRAINT termination_move_out_authorizations_offset_voucher_fk
      FOREIGN KEY (offset_voucher_id)
      REFERENCES public.income_expenses(id) NOT VALID;
  END IF;
END
$xfk_tma_offset$;

-- ========================================================================
-- ACTIVATION / ENROLLMENT GUARDS (G6) — placed after all tables
-- ========================================================================
-- =====================================================================
-- Group G6 guards — assembled LAST (§10.4 activation + canary gates, cohort CAS).
-- References app_private.finance_v2_activation_attestations /
-- finance_business_policy_decisions (G6 tables) and the pre-existing
-- app_private.server_feature_flags / server_feature_flag_canary_orgs.
-- =====================================================================

-- Advisory-lock helper, namespaced per Finance V2 feature key.
CREATE OR REPLACE FUNCTION app_private.lock_finance_v2_feature_rollout_v1(
  p_feature_key text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('finance-v2-feature-rollout:' || p_feature_key, 0)
  );
$$;
REVOKE ALL ON FUNCTION app_private.lock_finance_v2_feature_rollout_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- §10.4 feature-activation assertion (fail-closed; acts on the 7 Finance V2 keys only).
CREATE OR REPLACE FUNCTION app_private.assert_finance_v2_feature_activation_v1(
  p_feature_key text,
  p_mode text,
  p_organization_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
DECLARE
  v_config_version bigint;
BEGIN
  IF p_feature_key NOT IN (
    'income_expense.workflow.v2',
    'income_expense.posting.v2',
    'cashbook.access.v2',
    'income_expense.profit_close.v2',
    'income_expense.read_semantics.v2',
    'contract.commission.settlement.v2',
    'salary.settlement.v2'
  ) THEN
    RETURN;
  END IF;

  -- Only CANARY/ON transitions are gated; OFF/SHADOW require no attestation.
  IF p_mode NOT IN ('CANARY', 'ON') THEN
    RETURN;
  END IF;

  -- Row-lock the flag first (current config_version), then take the advisory lock.
  SELECT feature.config_version INTO v_config_version
  FROM app_private.server_feature_flags feature
  WHERE feature.feature_key = p_feature_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finance V2 feature % is not configured', p_feature_key
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_finance_v2_feature_rollout_v1(p_feature_key);

  IF NOT EXISTS (
    SELECT 1
    FROM app_private.finance_v2_activation_attestations attestation
    WHERE attestation.feature_key = p_feature_key
      AND attestation.config_version = v_config_version
      AND attestation.organization_id IS NOT DISTINCT FROM p_organization_id
  ) THEN
    RAISE EXCEPTION
      'Finance V2 activation of % blocked: missing attestation for config_version % (scope %)',
      p_feature_key, v_config_version, COALESCE(p_organization_id::text, 'GLOBAL')
      USING ERRCODE = '55000';
  END IF;

  -- Commission/salary settlement additionally require a business-policy decision.
  IF p_feature_key IN (
    'contract.commission.settlement.v2', 'salary.settlement.v2'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM app_private.finance_business_policy_decisions decision
      WHERE p_organization_id IS NULL
         OR decision.organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION
        'Finance V2 activation of % blocked: missing business-policy decision (scope %)',
        p_feature_key, COALESCE(p_organization_id::text, 'GLOBAL')
        USING ERRCODE = '55000';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.assert_finance_v2_feature_activation_v1(text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.assert_finance_v2_feature_activation_v1(text, text, uuid) IS
  '§10.4 fail-closed activation gate for the 7 Finance V2 keys (attestation + policy).';

-- Trigger fn + a11 trigger on server_feature_flags (coexists with a10 accounting guard).
CREATE OR REPLACE FUNCTION app_private.guard_finance_v2_feature_activation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
BEGIN
  -- Pass-through for non-Finance keys so the a10 accounting guard stays authoritative.
  IF NEW.feature_key NOT IN (
    'income_expense.workflow.v2',
    'income_expense.posting.v2',
    'cashbook.access.v2',
    'income_expense.profit_close.v2',
    'income_expense.read_semantics.v2',
    'contract.commission.settlement.v2',
    'salary.settlement.v2'
  ) THEN
    RETURN NEW;
  END IF;

  -- A freeze must always be installable.
  IF NEW.force_freeze THEN
    RETURN NEW;
  END IF;

  IF NEW.mode IN ('CANARY', 'ON') THEN
    PERFORM app_private.assert_finance_v2_feature_activation_v1(
      NEW.feature_key, NEW.mode, NULL
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_finance_v2_feature_activation_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a11_finance_v2_activation
  ON app_private.server_feature_flags;
CREATE TRIGGER a11_finance_v2_activation
BEFORE INSERT OR UPDATE OF mode, force_freeze
ON app_private.server_feature_flags
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_feature_activation_v1();

-- §10.4 canary-enrollment assertion (org-scoped attestation for the target config version).
CREATE OR REPLACE FUNCTION app_private.assert_finance_v2_canary_enrollment_v1(
  p_feature_key text,
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
DECLARE
  v_config_version bigint;
BEGIN
  IF p_feature_key NOT IN (
    'income_expense.workflow.v2',
    'income_expense.posting.v2',
    'cashbook.access.v2',
    'income_expense.profit_close.v2',
    'income_expense.read_semantics.v2',
    'contract.commission.settlement.v2',
    'salary.settlement.v2'
  ) THEN
    RETURN;
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Finance V2 canary enrollment requires an organization'
      USING ERRCODE = '22023';
  END IF;

  SELECT feature.config_version INTO v_config_version
  FROM app_private.server_feature_flags feature
  WHERE feature.feature_key = p_feature_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finance V2 feature % is not configured', p_feature_key
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_finance_v2_feature_rollout_v1(p_feature_key);

  -- Org-scoped attestation for the target config version is mandatory.
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.finance_v2_activation_attestations attestation
    WHERE attestation.feature_key = p_feature_key
      AND attestation.config_version = v_config_version
      AND attestation.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION
      'Finance V2 canary enrollment of % for org % blocked: missing org-scoped attestation (config_version %)',
      p_feature_key, p_organization_id, v_config_version
      USING ERRCODE = '55000';
  END IF;

  -- Commission/salary settlement additionally require a business-policy decision.
  IF p_feature_key IN (
    'contract.commission.settlement.v2', 'salary.settlement.v2'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM app_private.finance_business_policy_decisions decision
      WHERE decision.organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION
        'Finance V2 canary enrollment of % for org % blocked: missing business-policy decision',
        p_feature_key, p_organization_id
        USING ERRCODE = '55000';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.assert_finance_v2_canary_enrollment_v1(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_finance_v2_canary_enrollment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
DECLARE
  v_mode text;
  v_force_freeze boolean;
BEGIN
  -- Pass-through for non-Finance keys (a10 accounting enrollment guard owns those).
  IF NEW.feature_key NOT IN (
    'income_expense.workflow.v2',
    'income_expense.posting.v2',
    'cashbook.access.v2',
    'income_expense.profit_close.v2',
    'income_expense.read_semantics.v2',
    'contract.commission.settlement.v2',
    'salary.settlement.v2'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT feature.mode, feature.force_freeze
    INTO v_mode, v_force_freeze
  FROM app_private.server_feature_flags feature
  WHERE feature.feature_key = NEW.feature_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finance V2 feature is not configured'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_finance_v2_feature_rollout_v1(NEW.feature_key);

  IF v_mode = 'CANARY' AND NOT v_force_freeze THEN
    PERFORM app_private.assert_finance_v2_canary_enrollment_v1(
      NEW.feature_key, NEW.organization_id
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_finance_v2_canary_enrollment_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a11_finance_v2_canary_enrollment
  ON app_private.server_feature_flag_canary_orgs;
CREATE TRIGGER a11_finance_v2_canary_enrollment
BEFORE INSERT OR UPDATE OF feature_key, organization_id
ON app_private.server_feature_flag_canary_orgs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_canary_enrollment_v1();

-- §10.4 operational cohort CAS: atomically flips the 3 cohort keys
-- (income_expense.workflow.v2 / income_expense.posting.v2 / cashbook.access.v2)
-- together via set_feature_route_v1. STUBBED — the transactional cross-key CAS is
-- finalized in a later stage; the signature is created now so callers/tests can bind.
CREATE OR REPLACE FUNCTION app_private.set_finance_feature_cohort_v2(
  p_expected_workflow_version bigint,
  p_expected_posting_version bigint,
  p_expected_cashbook_version bigint,
  p_mode text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_max_operation_count integer,
  p_max_single_amount_vnd numeric,
  p_max_total_amount_vnd numeric,
  p_commit_sha text,
  p_migration_sha256 text,
  p_maintenance_window_id text,
  p_approval_reference text,
  p_actor uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $$
BEGIN
  RAISE EXCEPTION
    'set_finance_feature_cohort_v2 not yet implemented (cohort CAS finalized in a later stage)'
    USING ERRCODE = '0A000';
END;
$$;
REVOKE ALL ON FUNCTION app_private.set_finance_feature_cohort_v2(
  bigint, bigint, bigint, text, timestamptz, timestamptz, integer, numeric, numeric,
  text, text, text, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.set_finance_feature_cohort_v2(
  bigint, bigint, bigint, text, timestamptz, timestamptz, integer, numeric, numeric,
  text, text, text, text, uuid, text
) IS
  '§10.4 cohort CAS for the 3 read/write cohort keys — STUB (0A000) pending later stage.';

COMMIT;

NOTIFY pgrst, 'reload schema';