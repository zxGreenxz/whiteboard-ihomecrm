# T7 financial context + shared safe notes — implementation report

Scope: remaining authenticated financial-context capability, not T9 page integration. Base request 00ac7266; concurrent root commits retained. Adopted root pure financial model/test (8 tests) and added validated context, shared hook/reader, private ledger bridge, shared safe notes. No shared schema apply, business writes or history replay. Only disposable `settlement_t7`/55488 and its PostgREST55490 used for fixtures/schema.

## API / files

- `src/lib/contractSettlementFinancialContext.ts`: `SettlementFinancialScope`, `SettlementFinancialContext`, `parseSettlementFinancialContext`.
- `src/hooks/useContractSettlementFinancialFacts.ts`: target {roomId,contractId,terminationId?,voucherId?,sourceReceiptId?}; hook binds actor/org and exports `readSettlementFinancialContext(scope, signal)` + `settlementFinancialQueryKey(actorId,scope)` for multi-contract useQueries. `refresh()` rejects, stale data hidden on failure; polling/focus and source-table realtime. Namespace `settlement-financial-context` must be included by root shared action refresh.
- Money DTO verified(amount,basis) or unavailable(reason): depositRequired, gross depositReceived, otherReceived, currentDebt, terminationDebt, refundOwed, refunded, refundRemaining. Full source arrays/coverage and exact IDs/today/generatedAt accompany it. No empty/unknown→0 coercion; parser errors stay visible in Vietnamese with internal cause.
- Named shared hooks `useCommissionVoucherFacts` and `useTerminationRefundFacts` now return financial context, consumed by existing named note components through `SettlementFinancialNote`. No other production consumers found. Original notes remain separately labelled. Old postgres writer/name helpers unchanged and are no longer used by these hooks.

## SQL

Allocated migration `20260920205323_contract_settlement_financial_context.sql` creates:
- public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)
- app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)
- app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)

Public function owner is nonbypass ie_action_snapshot_reader with authenticated RLS, active-org/current membership guard, protected search_path and row_security=on. Private postgres helpers only executable by this reader; source IDs and completeness IDs stay internal. Ledger bridge is invoked for outer-visible voucher IDs and org-checks again; no public table/private cashbook grants. Source union includes direct contract, reviewed deposit links, invoice/payment/collection/tender relationships and deduplicates IDs. Missing payment receipts/external links and hidden receipts/items/invoices invalidate coverage. Active posting identity/account/amount/effective net/reversal/virtual checks precede item allocation. Partial cash mismatch remains unavailable rather than proportional allocation. No LIMIT/PostgREST row pagination: one scalar JSON response contains full set.

Exact requested target preserved. Historical room allowed only through trusted residence helper; precontract source has independent sourceReceipt scope. Termination is exact requested or uniquely linked voucher obligation, never latest contract termination. Current debt uses conservative carry graph, not invoice.paid_amount as cash. Refund owed requires approved/completed termination plus usable exact obligation; unmapped legacy refunds are partial, never paid zero. Private definition/owner/ACL and role membership drift guards; reapply and nonsuperuser first-apply rehearsed.

## Verification actually run

Pinned final runtime: Node24.18.0 at C:/Users/Nguyen Tam/AppData/Local/npm-cache/_npx/4aa47c519def57bc/node_modules/node/bin/node.exe. Initial small TDD runs used PATH Node22.20.0 before root supplied pinned path; final affected suites/runtimes used24.18.0.

- Boundary RED missing module, then 3 GREEN; additional draft-termination obligation test RED verified-vs-unavailable, fixed→4 GREEN.
- Hook RED missing module, then refresh test adjusted to wait for Query notification, GREEN. Shared renderer RED missing module→GREEN. Legacy commission null notes RED (0đ/false7days)→GREEN.
- Final focused run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlementFinancialFacts.test.ts src/lib/__tests__/contractSettlementFinancialContext.test.ts src/hooks/__tests__/useContractSettlementFinancialFacts.test.tsx src/components/income-expenses/__tests__/SettlementFinancialNote.test.tsx src/lib/__tests__/commissionVoucherNote.test.ts src/lib/__tests__/terminationRefundNote.test.ts` = 36 tests / 6 files PASS; context4 rerun PASS after last draft guard.
- `node scripts/test-settlement-financial-reader-local.mjs`: initial PGRST202 RED before endpoint; PLpgSQL ambiguous variable fixed; authenticated JWT PASS. Exact middle contract signedDate; hidden source marks partial; 6m cash receipt item split 4m DEPOSIT/2m PNL; ordinary viewer direct postings query returns[] while bridge active posting present; explicit deposit link without direct contract retained and direct+linked deduplicated; exact termination debt700000; unmapped legacy refund RED truecoverage then fixed false; hidden building, superadmin without membership, revoked/future/expired membership, suspended org, room/org mismatch denied. Fixture compares voucher before/after read, cleans exact IDs. 1002 receipts returned/1request; timings218–253ms before explicit link fixture, latest4939ms after link (not production performance evidence).
- `node scripts/test-settlement-financial-schema-local.mjs`: reapply twice, function search_path drift, private EXECUTE drift, role membership drift, private ACL/authenticated public-only, first/reapply as nonsuperuser, all rollback PASS. An initial attempted cyclical membership mutation was rejected by PostgreSQL before gate; changed test to anon grant to exercise actual guard.
- RLS mutation public reader owner→postgres: JWT test RED hidden-source coverage true≠false; owner restored in finally and normal JWT PASS.
- Money mutation item DEPOSIT filter→all items:2/8 tests RED (mixed split/gross deposit), source restored SHA2562080448191fe0f52a4573b31c78f4815dcd8151b2e380976ff73dc9e2a77b0a7. Root prior active-net comparator mutation evidence retained in brief; not claimed as this turn's mutation.
- Local read-only transitive STABLE gate SQL:0 findings for3new functions.
- AppTS session42922 exit0; fresh94742 requested after tiny final draft guard/comment cleanup (result appended below).
- RPC cast ratchet0, RPC-in-view no newsites, RPC layer0 PASS. Test matrix758files/11suites PASS, operator harness entries added. git diff --check PASS after line-ending cleanup.
- Own4new modules registered strict-islands without baseline increase. Whole strict gate36508 RED2 unrelated locked files: PeriodFeePanel.tsx152 / PeriodFeeSheet.tsx133 PeriodFeeStatus vs PeriodFeeOverviewStatus. No errors reported in own new modules. Did not weaken config or edit unrelated files.
- Shared `check-view-invoker.mjs` unavailable (no PAT). Initial guessed check-rpc-any-cast filename did not exist; correct check-rpc-cast-ratchet then PASS. These are not passing shared gates.

## Integration limits / concerns

Not full T7/T9 UI done. Root owns multi-lane query integration and shared action refresh namespace. Generated types/provenance/shared forward apply and role E2E remain root release lane; typed facade validates runtime payload, no generated hand edit.

Safe shared renderer retains verified scalar facts and exact termination notes; legacy numeric deduction breakdown (credit parsed from notes, latest SETTLEMENT invoice) is intentionally not reconstructed. Per-field typed deduction breakdown remains modal integration work; no fallback0. Commission business notes now show safe current financial context; old pure formatting function additionally rejects missing facts, but legacy helper is not reused as cash proof.

Current debt is unavailable for legacy/ambiguous carry graph rather than guessing by month. V5 gross/retained allocation mismatches, missing/unknown source links, unsupported legacy header/item formats remain unavailable, not manufactured amounts. UI wording explicitly includes credit/internal held amounts in other receipts. A dedicated V5 allocation breakdown/legacy ambiguous-change fixture and historical transfer JWT fixture were not run in this bounded implementation; model tests cover partial amount refusal, NON_CASH, reversed, virtual and carry ambiguity. Real cash evidence from a full header can be split only when all item sums match that full cash amount. No claim of historical debt reconstruction.

Final app TypeScript session94742: exit0 under Node24.18.0.
