# Invoice Adjustment Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. This repairs the existing feature under the user's explicit request of 12/09/2026.

**Goal:** Restore collection and make issued invoice editing preserve current obligations, immutable history, posted allocations, permissions and useful failure messages.

**Architecture:** Each edit to an issued invoice appends an invoice adjustment revision and a complete financial component manifest revision. Current invoice_items/header represent the latest document; snapshots and historical payment/posting/component allocations remain immutable. Changes that would rewrite already posted money require canonical reversal first, then normal editing/recollection using CREDIT or REFUND as appropriate.

**Tech Stack:** PostgreSQL/Supabase, React, TanStack Query, React Hook Form/Zod, Vitest/PGlite, Playwright.

## Global Constraints

- Read PROJECT_CONTRACT.md. Main org business data is read-only; all write fixtures are DEMO and cleaned up or rolled back.
- Keep migration history immutable; allocate new filenames with scripts/tao-ten-migration.mjs. Production DDL goes through migrate:forward with backup and reviewed clean SHA.
- Do not alter payment, posting, collection tender or finalized historical allocation rows to make an adjustment fit.
- No new adjustment credit writer. If a change reduces money already allocated, it must fail with a clear canonical reversal instruction. The existing V5 CREDIT/REFUND path handles recollection after reversal.
- Backend validates the document and current state; UI never silently discards an editable field or reports a technical SQL error as success.
- No bypass of accounting feature flags, open integrity exceptions, RLS, account possession or approval gates in tests.
- Test each change with a failing test first; run meaningful money/permission mutations. Review each task independently and report unverified live checks.

## Task 1: Atomic revisions and financial component snapshots

**Files:** New forward migration(s) in supabase/migrations, focused SQL runtime tests in src/lib/__tests__, a rollback-only live probe in docs/audits/2026-09-12-invoice-adjustment-repair.probe.sql plus a narrowly scoped runner if needed. Do not edit frontend files in this task.

**Produces:**

```sql
public.adjust_invoice_v2(
  p_invoice_id uuid, p_after_items jsonb,
  p_discount_amount numeric, p_discount_notes text, p_notes text,
  p_reason text, p_expected_revision bigint, p_expected_paid_amount numeric,
  p_expected_updated_at timestamptz, p_idempotency_key text
) RETURNS public.invoice_adjustments;
public.review_invoice_adjustment_v2(p_adjustment_id uuid, p_expected_revision bigint)
RETURNS public.invoice_adjustments;
```

Invoice columns `adjustment_revision bigint NOT NULL DEFAULT 0` and
`adjustment_review_status text NOT NULL DEFAULT 'NONE'` summarize the latest revision for correct server-side filters. The latter permits NONE/PENDING/CHECKED. Add a request fingerprint to adjustments for payload-aware idempotency; no arbitrary one-edit limit.

- [ ] Write behavioral tests for two edits, same-key replay/mismatch, stale paid/revision/updated_at, cross-org/building deny, malformed/negative/NaN item values, total unchanged but line semantics changed, discounts actually saved, and review money immutability.
- [ ] New writer locks invoice, checks organization/building/edit capability and valid issued state, authorizes before replay. Normalize key before lookup. Same key+same request returns the original result; same key+different request raises 23505. State mismatch raises 40001. Fresh save appends revision and before/after snapshots including editable header fields and all normalized items.
- [ ] Server derives amounts from unit_price, quantity, coefficient with defaults matching the ordinary invoice writer and rounds totals with app_private.round_invoice_total_v1. Do not trust client subtotal/total/amount. Validate supported item type/accounting_class and owned service IDs. Reject empty or malformed documents and invalid discounts/negative total; handle no-op documents clearly. Do not silently ignore metadata edits.
- [ ] Issued adjustment edits items, discount, discount notes and invoice notes. Contract/building/room/billing month/issue/due date/debt sources are outside this RPC; the issued UI locks those fields. DRAFT stays with the ordinary writer. Both paid and unpaid issued invoices, and invoices with adjustment history even when paid returns to zero, use v2.
- [ ] Validate after obligations against active semantic coverage (PNL/DEPOSIT/INTERNAL) AND financial component coverage by component_kind, not only after_total >= paid. An after component below already allocated money, active rounding, active credit applications or debt carried to later invoice must fail with an actionable reversal/settlement message. Reversed payments alone are not a permanent ban; active coverage determines safety. Mixed legacy coverage that cannot be proved is rejected explicitly; pure single-component legacy PNL may use independently proved paid coverage without fabricating allocations.
- [ ] Insert revision, UPDATE current header and replace current invoice_items in one transaction, preserving originals in snapshots. Call component sync and recompute before returning. No excess_amounts INSERT. Existing legacy adjust_invoice_v1 must fail safely with a reload instruction, rather than retain the corrupt writer. Old update_invoice_v1 must not bypass revisions for issued/revised invoices.
- [ ] Version finance_invoice_component_manifests with adjustment_revision and source_adjustment_id, unique(invoice_id,adjustment_revision), source adjustment composite org/invoice FK. Existing manifests stay revision 0, old finalized components/allocations unchanged. Sync function selects/creates the manifest for the latest invoice adjustment revision, rather than returning the original finalized manifest.
- [ ] Pin each new collection to component_manifest_id at its creation (internal trigger or writer, preserving org/invoice identity), old collections NULL resolve to revision 0. Allocator uses the pinned manifest but subtracts prior ACTIVE coverage by component_kind across ALL revisions; exclude current collection from prior coverage. Keep allocation rows immutable.

```text
Revision 0: CURRENT_CHARGE 100, CURRENT_DEPOSIT 20; collected CURRENT_CHARGE 50.
Revision 1: CURRENT_CHARGE 80, CURRENT_DEPOSIT 30.
Next collection 60 => CURRENT_CHARGE 30 + CURRENT_DEPOSIT 30.
Reversing that collection leaves original CURRENT_CHARGE 50 unchanged.
```

- [ ] Update business_performance_invoice_cohort_v1: obligation component_pivot chooses one latest manifest, historical allocation_facts keeps its component ID joins across all revisions. No multiplying invoice counts/billed amounts, no dropping old collections.
- [ ] Harden direct guards without changing SECURITY INVOKER. Dispatch by table/operation before field access. For direct item DML lock parent invoices in stable ID order even when paid=0, then enforce paid/revision immutability; check both parents on move. Keep RPC owner paths authorized by their own checks.
- [ ] Add sandbox-hide policy and scoped read permissions for invoice_adjustments; protect delete and non-review mutations. Review is monotonic PENDING->CHECKED, requires approve capability and exact current revision, changes only review fields and latest invoice review summary.
- [ ] Run SQL runtime tests, live DEMO rollback integration, money/permission/migration mutations and migration double-application. Capture exact commands/results in the task report. Do not apply production or commit generated types by hand. Commit only owned files and report the live tests still needed.

## Task 2: Typed editing and consistent invoice views

**Files:** src/lib/invoiceAdjustmentRpc.ts (new typed/Zod boundary); src/hooks/useInvoices.ts; src/types/invoice.ts; src/lib/invoiceUtils.ts; EditInvoiceDialog.tsx; InvoiceDetailView.tsx; InvoiceDetailMobile.tsx; InvoiceListFilters.tsx; shared adjustment history component if useful; focused tests next to those modules.

**Consumes:** Exact Task 1 v2 signatures and latest-revision invoice summary columns. Generated types are obtained from the database generator after the schema is reviewed/applied; never handwritten.

- [ ] Add failing tests for actual current items/defaults, saved discount/notes, required separate reason, stable idempotency key for unchanged retries, refreshed key for changed payload, stale conflict feedback, and server-side latest-review filtering.
- [ ] Replace the untyped dynamic RPC cast with typed literal calls and Zod result validation. Keep mutation errors visible and distinguish validation, permission and stale state. Invalidate invoice/list/statistics, collection-report, invoice-items, credit/finance-related queries actually used by the touched views.
- [ ] All issued/revised invoices use v2, even with paid_amount=0. DRAFT ordinary editing remains. Capture expected revision/paid/updated_at from the loaded invoice. Use a stable idempotency key tied to normalized request payload; prevent duplicate submission; refresh the document explicitly after conflict.
- [ ] Editable values are current after-items and discount/notes. Separate adjustment reason from invoice notes and require 3..1000 trimmed characters. Show before/current/after totals and affected amount. Lock metadata outside the issued RPC with a concise reason. Never allow user to change a field and then silently ignore it.
- [ ] Display immutable original and revision snapshots with correct amounts on desktop/mobile; show newest invoice items as current. Avoid duplicate adjustment rendering on mobile and keep totals consistent with snapshots. Review buttons have approve capability, pending state, stale revision handling and expected revision argument.
- [ ] Filter by invoice.adjustment_review_status on the server before pagination; do not filter only a fetched page or match any old checked revision. Use deterministic revision sorting when displaying history.
- [ ] Add contextual links to payment history for canonical reversal when backend reports already allocated money/rounding/credit/carry constraints. No automatic real-organization mutation is performed by the agent.
- [ ] Run focused UI/hook/boundary tests, typecheck:baseline, build and bundle checks. Commit owned changes and record evidence.

## Task 3: Integration, browser verification and release

**Files:** Focused .e2e-fleet spec for adjustment+collection paths; audit evidence/provenance/generated catalog and types owned by existing generators.

- [ ] Run DEMO real-JWT/PostgREST two-request concurrency tests for same key, different key, adjustment versus collection, and two stale adjustments. Verify historical payment/posting/allocation hashes remain unchanged and cleanup reverses all fixture money before deleting scaffolding.
- [ ] Headless E2E: invoice page partial collection, edit issued invoice, collect remaining in Thu tiền, review, filter, second edit/retry, reverse and edit again. Include mobile details and console errors; no swallowed skips.
- [ ] Execute both reconcile-money gates, sandbox leakage gate at configured main checkout, stable-fn-locks, catalog/types/provenance, typecheck/build and gate:truoc-push on final SHA. If an unrelated gate fails, diagnose it and preserve the evidence rather than bypassing it.
- [ ] Independent whole-change review. Fetch/rebase, resolve generated conflicts from main and regenerate. Draft PR before main. Apply only reviewed migrations using the forward lane with backup. Promote app only with the documented exact-SHA CI gate. Verify deployed UI/RPC and update audit with receipt/SHA and any remaining limitation.
