# Payment rounding implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Each independent item uses its own worktree. User authorized behavior in the 08/09/2026 request; implement and produce a reviewable money change.

**Goal:** Editable actual change, correct <10.000đ waiver accounting, and billing-period/collector reporting.

**Architecture:** Preserve V5 signature and writer semantics. Optional per-TM tender requested_change_amount carries actual refund; the canonical planner and SQL apply net retained money. Report existing durable rounding records without duplicating money.

**Tech Stack:** React, TypeScript, Vitest, PostgreSQL/Supabase, Playwright.

## Global constraints

Follow PROJECT_CONTRACT; real org read only; isolated worktrees; timestamp allocator for migrations; immutable history; 0 < waiver < 10.000đ; never waive deposit debt; credit unchanged; money changes require independent review and draft PR.

### Task 1: Canonical SQL and reporting contract

- [ ] Read latest deployed V5/guards/reversal and compare source. Add forward migration only after tests specify actual TM refund, net allocation, rounding and all old guards.
- [ ] Extend p_tenders with optional requested_change_amount per TM. Require all TM lines explicit when any explicit; omit fields for legacy. Validate money, TM bound, no under-refund, positive net; derive applied and rounding after actual refund. Preserve idempotency and locks.
- [ ] Add typed report RPC get_invoice_rounding_report_v1(p_billing_month text, p_collector_id uuid default null, p_building_id uuid default null, p_offset int default 0, p_limit int default 100) returning rows, total_count, total_amount, invoice_count, by_collector. Rows: payment_id, collection_id, invoice_id, invoice_number, building_id/name, room_name, billing_month, collection_date, collector_id/name, gross_amount, change_amount, applied_amount, rounding_amount, reason (UNDERPAYMENT/EXTRA_CHANGE/LEGACY). Existing rounding is authoritative; exclude reversal/cancellation; server scope checks.
- [ ] Add DEMO rollback harness for payment, reversal, report sums, role boundaries, retry/concurrency. Run static checks and prepare migration review/evidence. Do not deploy independently.

### Task 2: Shared math and collection forms

- [ ] RED tests for planInvoiceCollection/planCollect on actual change: 5.000.000 − 200.000 against 4.805.000 => applied 4.800.000, rounding 5.000; exact 10.000 => no waiver; cannot under-refund, exceed TM, waive deposit, or mix credit.
- [ ] Extend RecordInvoiceCollectionInput with actual_change_amount?: number; normalize to per-TM requested_change_amount JSON distributed from last TM backwards; preserve exact old payload when undefined. Extend planCollect with changeAmount?: number.
- [ ] Wire useInvoicePayments, useBulkRecordPayment, useQuickCollect and all dialogs to planner; use actual change for preview and fingerprint. Editable accessible inputs in keypad/pay form; reset custom amount on base inputs change, credit toggle, invoice switch.
- [ ] Display exact waiver separately from actual money and debt; boundary at 10.000; source-specific errors; run planner tests and headless UI tests.

### Task 3: Reporting UI

- [ ] Add strict domain wrapper/parser, hook, reusable report dialog with period/collector/building filters, totals/grouping/details and pagination. Reuse existing permissions (thu_tien.report).
- [ ] Add entry from Thu tiền report and Hóa đơn; preserve current billing period selection. Show loading/error/empty states, distinguish historical reason and undone rows excluded. Invalidate report on record/reversal.
- [ ] Test data parsing, grouping/counts and paging; check responsive rendering headless.

### Task 4: Integrate and review

- [ ] Integrate task commits; regenerate types through approved generator when schema available; no manual generated edits. Run typecheck, related tests, build/bundle, money mutations, two reconciliations, migration gates and graph detect-changes.
- [ ] Independent code review, fix findings and rerun affected checks. Produce draft PR with measured gates and rollout state; follow authorized forward migration lane with backup/evidence when applicable.
