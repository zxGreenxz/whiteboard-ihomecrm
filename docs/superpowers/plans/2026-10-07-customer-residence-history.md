# Customer residence history implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the task, then one independent final review of the final diff and receipts as PROJECT_CONTRACT requires.

**Goal:** Make the existing customer room cell show present accommodation or actual departure and open durable residence history.

**Architecture:** Record meaningful customer membership and contract lifecycle events server-side, preserve snapshots after unlink/deletion, expose scoped batch summaries and paginated history through typed domain services. Reuse the existing table cell and a lazy history dialog with explicit incomplete-data/loading/error states.

**Tech Stack:** React, TypeScript, TanStack Query, shadcn, Supabase/PostgreSQL, Vitest, PGlite, browser fixture QA.

## Global constraints

- Work only in `C:/Users/Nguyen Tam/codex-worktrees/customer-residence-history`; preserve main checkout WIP.
- No extra departure column. Current room or `Đã rời · dd/MM/yyyy`, clickable for history. Unknown departure is `Đã rời · Chưa rõ ngày`.
- Real organizations are read-only. No remote schema apply/deployment. Use a disposable local database for SQL tests.
- Never edit existing migrations or generated types by hand; no new `any`, baseline weakening or silent fallback.
- No invented historical dates/reasons. Contract expiry alone is not move-out; re-entry and multiple active residences are handled.
- Migration/security changes need independent crossReview and draft PR. Stage named files only; commit trailer `Co-Authored-By: Codex <noreply@openai.com>`.

## Task 1: Durable history, readers and customer UI

**Inputs:** The approved spec at `docs/superpowers/specs/2026-10-07-customer-residence-history-design.md`.

**Source seams:** `src/hooks/useCustomers.ts`, `src/hooks/useContracts.ts` (`useSyncContractCustomers`), `src/lib/contractEditWorkflow.ts`, `src/lib/contractRelationReconcile.ts`; `src/components/customers/CustomerListTable.tsx`, `src/pages/customers/CustomersPage.tsx`, `src/pages/customers/CustomersMobilePage.tsx`; current contract signing/exit/transfer SQL under `supabase/migrations/` and generated schema for actual column names.

**Files:** Add a timestamped forward migration using `node scripts/tao-ten-migration.mjs customer_residence_history`. Add a focused domain service `src/lib/customerResidenceHistory.ts`, hook `src/hooks/useCustomerResidenceHistory.ts`, dialog `src/components/customers/CustomerResidenceHistoryDialog.tsx`, and focused behavior tests colocated in `__tests__`. Add/change other small domain files only where needed for atomic member reconciliation, realtime invalidation and existing page integration.

**Interfaces:** Domain `CustomerResidenceSummary` carries customer id, current accommodation(s), departure date and data completeness. Domain `CustomerResidenceEvent` carries event id, effective date nullable, recorded timestamp, event kind, customer/contract/building/room identity, display snapshots, reason and actor when known. Reader API takes selected organization plus customer id(s), respects database permissions, rejects malformed responses, scopes cache by org and subject. History is paginated with deterministic ordering; UI can load all pages. Use existing typed repository facade pattern if generated types cannot be refreshed before remote deployment; make provisional schema contract explicit and SQL-tested.

- [ ] Inspect actual lifecycle writers, membership schema and scope authorizers before choosing SQL trigger/RPC seams. Distinguish reservation from actual residence and signing from late membership.
- [ ] Write and run failing SQL behavior tests using PGlite. At minimum: add/remove/re-add, metadata-only update/no-op creates no event, transaction rollback, forbidden org/tòa/role, immutable history, terminated vs merely expired, exit reasons, transfers, deleted contracts, migration replay; legacy snapshot evidence and unknown dates.
- [ ] Implement forward migration and narrow atomic reconciliation writer. Example invariant for no-op:
  ```ts
  const before = await readHistory(customerId);
  await saveSameMembersWithChangedNotes(contractId);
  expect(await readHistory(customerId)).toEqual(before);
  ```
- [ ] Run focused SQL tests to green; mutate a load-bearing authorization/event invariant and prove a relevant test goes red, then restore original bytes/hash.
- [ ] Write failing domain/hook/UI tests. Cell examples: active room opens history; exited customer shows actual date; returned customer shows current room but keeps earlier events; missing date is explicit; query failure shows retry; append pages does not lose entries. Test late-added customer never inherits contract start date.
- [ ] Implement typed domain boundaries, query/cache invalidation, lazy dialog and same-cell UI on desktop/mobile. Fetch summary only for customer rows on current page, not each row or closed details. Details should show unknown/incomplete history honestly.
- [ ] Run only focused affected tests to green. Supply exact test commands/results in the report; do not run aggregate gate or broad build (controller handles final gate once).
- [ ] Self-review actual diff for duplicate events, fabricated history, scope leaks, concurrency, unresolved UI state. Stage only changed named files and commit implementation with required trailer. Do not push or apply remote migrations.

## Task 2: Verification and review

- [ ] Stage named final files; generate provenance/surfaces only as required and possible without remote mutation. Read `npm run gate:truoc-push -- --plan`; run the selected gate once. Preserve unchanged passing receipts and report blocked external checks accurately.
- [ ] Browser desktop/mobile affected flows with controlled fixtures, screenshot and console. Do not write real tenant data. If browser environment is unavailable, explicitly record UI/E2E unverified.
- [ ] Independent final diff + evidence review, fix concrete findings and re-review only changed pieces. Follow PROJECT_CONTRACT one final review rather than repeating per-task broad reviews.
- [ ] Fetch/compare main before any integration; retain draft branch/PR for schema changes. No promotion with incomplete required evidence. Report what is implemented, test evidence, and exact deployment limitations in Vietnamese.
