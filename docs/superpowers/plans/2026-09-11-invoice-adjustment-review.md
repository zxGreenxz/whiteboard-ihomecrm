# Invoice Adjustment Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add atomic paid-invoice adjustments with immutable history, customer debt/credit reconciliation, review workflow, filters, and secure authorization.

**Architecture:** A forward migration owns immutable snapshots, adjustment revisions, idempotent money reconciliation, and review RPCs. Typed hooks call those RPCs; invoice detail/list render the audit and review state.

**Tech Stack:** Supabase PostgreSQL/PLpgSQL, React, React Hook Form, TanStack Query, Vitest.

## Global Constraints

- Server recomputes all money and enforces organization/building scope.
- Money writes use one transaction, row locks, idempotency, and append-only evidence.
- Preserve existing payment/credit ledger invariants and generated-type workflow.

### Task 1: Database model and atomic adjustment RPC

**Files:** Create a forward migration under `supabase/migrations/`; update RPC surface/types through generators.

- Add `invoice_adjustments` with organization, invoice, revision, reason, before/after snapshots, signed delta, actor/time, review fields and unique `(invoice_id, idempotency_key)`.
- Add immutable trigger/policies and composite org foreign keys.
- Implement `adjust_invoice_v1(...)` with `FOR UPDATE`, capability/building/org checks, state/payment guards, server-side item normalization/rounding, debt/credit ledger reconciliation, carry-over dedupe, and idempotent replay.
- Implement `review_invoice_adjustment_v1(adjustment_id, expected_revision)` with check capability, row lock, checked actor/time only.

### Task 2: Typed client boundary

**Files:** `src/hooks/useInvoices.ts`, `src/types/invoice.ts`, generated Supabase types.

- Add typed mutation hooks for adjustment and review RPCs; invalidate invoice, payments, credit and list queries.
- Keep existing ordinary edit RPC blocked for paid invoices.

### Task 3: Edit and detail UI

**Files:** `src/components/invoices/EditInvoiceDialog.tsx`, `InvoiceDetailView.tsx`, `InvoiceDetailMobile.tsx`.

- Render original rows read-only gray and adjustment rows as currency inputs.
- Show calculated before/after/delta and require a reason.
- Show audit metadata and review button gated by capability.

### Task 4: List filter and tests

**Files:** `InvoiceListFilters.tsx`, list query/types, focused tests under `src/components/invoices/__tests__` and `src/hooks/__tests__`.

- Add adjustment review filter and badges.
- Test paid adjustment, credit/debt delta, idempotency, unauthorized review, and before/after rendering.

### Task 5: Verification and release

- Run focused Vitest, app typecheck/build, migration provenance and money/security gates.
- Run `gate:truoc-push`; create draft PR because money/permissions/migration changed.
- Only after CI and production catalog/backup evidence pass, use the documented promotion command for the exact SHA.
