# Phase-0 Inventory — Thu Chi V2 Finance Migration (Consolidated)

> Authoritative basis for authoring the 13 migration stages. Synthesized from 12 parallel readers. **Central fact:** `income_expenses.approval_status` (DEFAULT `'APPROVED'` NOT NULL since `supabase/migrations/20260426000002_thu_chi_remove_approval_add_cancel.sql:16`) is a **single predicate serving four meanings** — authorization (WORKFLOW), cash-moved (CASH_TRUTH), P&L-recognized (PROFIT), and provenance (OTHER). No `income_expense_postings` table exists yet; "cash moved" is currently expressed as `APPROVED + non-virtual account_id + non-internal source` (see the correct model at `src/lib/voucherSources.ts:97` / `src/hooks/income-expenses/queries.ts:195`) and, for invoice paths, a companion `payments` row. The posting *columns* (`posting_id`, `posted_at_v2`, `reversed_by_posting_id`) already exist on `income_expenses` and are stamped by `transition_canonical_income_expense_v1`, but the posting *table* does not.

---

## 1. APPROVED consumer classification

Grouped by which of the four overloaded meanings each surface reads. **🔴 = treats APPROVED as real cash with NO account/virtual/internal filter → must-fix under §11.2 (repoint to posting lines).** 🟡 = APPROVED-as-cash but scoped by account (lower blast radius). 🟢 = correct/reference model. Recognition (PROFIT) surfaces are arguably correct to keep on approval, but must be a *deliberate* decision at the `fa_accrual_allocations` chokepoint.

### CASH_TRUTH consumers

| Surface | Ref | Note |
|---|---|---|
| 🟢 **Canonical cash model** (`voucherLayer`) | `src/lib/voucherSources.ts:97` | CANCELLED→CANCELLED; UNAPPROVED or `!account_id`→PENDING; all-virtual/internal→INTERNAL; else→CASH. The reference the buggy hooks should adopt. |
| 🟢 **Canonical CASH filter** (server) | `src/hooks/income-expenses/queries.ts:195` | `APPROVED AND account_id NOT NULL AND system_source NOT internal AND acc.is_virtual=false`. INTERNAL layer at `:199`, PENDING at `:200`. Stats RPC `get_income_expense_layer_stats` at `:590`. |
| 🔴 **Sổ quỹ ledger list (PRIMARY FE BUG)** | `src/hooks/useCashBook.ts:45` | Builds cash ledger from `APPROVED + not-deleted` ALONE — no account/virtual/internal filter. Approved-no-book + internal offsets leak in as real cash. |
| 🔴 **accounts_with_balance view (CANONICAL ROOT #1)** | `supabase/migrations/20260704100000_accounts_is_virtual.sql:51-59` | `current_amount = initial + Σ(INCOME) − Σ(EXPENSE) + Σ(change_amount) + Σ(rounding_amount)`, **every leg `approval_status='APPROVED'`**. Lifetime running balance, no date bound. Duplicated verbatim across 5+ migrations. THE central cash-truth surface. |
| 🔴 **cashbook_period_totals RPC (ROOT #2a)** | `supabase/migrations/20260710170000_money_aggregate_rpcs.sql:167` | Period income/expense `WHERE APPROVED AND deleted_at IS NULL`. Feeds `useCashBookSummary` (`useCashBook.ts:97`). |
| 🔴 **cashbook_opening_balance RPC (ROOT #2b)** | `supabase/migrations/20260610110000_perf_indexes_cashbook_rpc.sql:46-56` | Signed opening sum, APPROVED-gated, `voucher_date < before`. |
| 🔴 **cashflow_by_day RPC (ROOT #2c)** | `supabase/migrations/20260710170000_money_aggregate_rpcs.sql:175-194` | Per-day cash chart, APPROVED-gated, grouped by `voucher_date`. |
| 🔴 **cashbook_settlement_report** | `supabase/migrations/20260701130000_cashbook_reconciliation_report.sql:192-207` | `period_collected`/`period_spent` = Σ APPROVED (with `handover_transfer_id IS NULL` guard). Dup at `20260704100000:106`. FE `src/hooks/useSettlementReport.ts:65`. |
| 🔴 **propose_reconciliation** | `supabase/migrations/20260701130000_cashbook_reconciliation_report.sql:82-102` | Snapshots `accounts_with_balance.current_amount` as system side of every reconciliation. |
| 🔴 **create_opening_adjustment** (reads+writes APPROVED) | `supabase/migrations/20260704150000_create_opening_adjustment.sql:57-96` | Reads system balance, writes APPROVED adjustment voucher to force book = counted cash, sets lock_date. |
| 🔴 **create/confirm_cash_handover** | `supabase/migrations/20260701120000_cash_handover_net_sweep.sql:117-137, 249-351` | Net sweep = Σ APPROVED income − Σ APPROVED expense; writes APPROVED pair as the actual inter-book cash move. |
| 🔴 **Refund log (Sổ tiền thối/Làm tròn)** | `src/pages/payments/RefundLogPage.tsx:82-115` | Second overload: `change_amount`/`rounding_amount` legs, APPROVED-gated. **NOT paged (cap-1000 risk).** SQL sibling `20260512000003_refund_log_balance_and_notes.sql:42`. |
| 🔴 **useInvoiceCollectors (đã thu/invoice)** | `src/hooks/useInvoiceCollectors.ts:50` | APPROVED+payment_id = money collected, no book/virtual filter. |
| 🔴 **useUtilityBills (đã đóng NCC)** | `src/hooks/useUtilityBills.ts:304, 425` | APPROVED expense = paid-to-provider. |
| 🔴 **useShareholderProfit (đã chia/đã trả)** | `src/hooks/useShareholderProfit.ts:308, 375` | APPROVED expense payout = paid-out; reduces distributable. |
| 🔴 **useManagerSalary advances** | `src/hooks/useManagerSalary.ts:382` | ADVANCE + APPROVED = ứng lương đã trả. |
| 🔴 **deposit_paid = Σ APPROVED** | FE `useDeposits.ts:39`, `useContractFormState.ts:204`, `useContractSubmit.ts:302`; SQL `recompute_contract_deposit_paid` `20260702120000_kqkd_item_level.sql:447` | Contract `deposit_paid`/shortfall/debt derived from Σ APPROVED deposit items, not posting. |
| 🔴 **usePeriodFees paidAmount / PeriodFee panels** | `src/hooks/usePeriodFees.ts:48`; `PeriodFeePanel.tsx:218`, `PeriodFeeSheet.tsx:291`, `PeriodFeeVoucherList.tsx:38` | "đã đóng" = Σ status='APPROVED'. |
| 🔴 **recompute_invoice_for_id** (paid_amount ± APPROVED cash legs) | `supabase/migrations/20260721100000_invoice_collection_v5.sql:378-398` | Subtracts APPROVED 'Tiền thối', adds rounding, subtracts settlement refund — all APPROVED. |
| 🔴 **get_reservation_deposit_summary.holding_amount** | `supabase/migrations/20260710170000_money_aggregate_rpcs.sql:102` | `SUM FILTER (APPROVED)` = cash actually held. |
| 🔴 **legacy_payment_receipt_semantics / payment_receipt_events** | `supabase/migrations/20260721102000_active_payments_reporting.sql:38, 454` | Real returned-change / reversal timeline gated APPROVED. |
| 🟡 **useUnhandedVouchers** | `src/hooks/useCashHandovers.ts:66` | APPROVED on a specific account = cash to hand over; scoped by account but no `is_virtual` check. |
| 🟡 **RefundLog change/rounding**, **termination net-settlement source-selection** | `supabase/migrations/20260603000020_termination_net_settlement.sql:79`; `20260603000022`, `20260618000001` | "Find real paid deposit" = Σ APPROVED income. |
| 🟡 **invoice-statistics / deposit_collected** | `supabase/migrations/20260702120000_kqkd_item_level.sql:684`; `20260630120000:195`; `20260610100000:176`; breakdown RPCs `20260621000001:56`, `20260703160000:106`, `20260621110000:43` | deposit/collected = Σ APPROVED income. |
| 🟡 **get_period_maintenance / period-fee status** | `supabase/migrations/20260708130500_get_period_maintenance.sql:59`; `20260710120000:156`, `20260710120600:167` | "paid when APPROVED, PENDING when UNAPPROVED". |
| **Balance display consumers** (auto-correct once view repointed) | `useAccounts.ts:99` (`accounts-with-balance`); `CashbooksMobilePage.tsx:41` (TỔNG TỒN QUỸ); `CashbookList.tsx:182`, `CashbookListMobile.tsx:96`, `CashbookDetailDialog.tsx:114` | Render `current_amount`; no local formula. |

### WORKFLOW consumers (clean — approval state machine)

| Surface | Ref |
|---|---|
| approve/unapprove/cancel/restore mutations | `src/hooks/income-expenses/statusMutations.ts:124,175,220,308`; SQL `20260703160000_approve_voucher_permission_guard.sql:29`; `20260721120000_profit_payout_reservations_v2.sql:1211` (`transition_canonical_income_expense_v1`) |
| canEdit/canDelete = UNAPPROVED, buildVoucherPayload | `src/hooks/useIncomeExpensesHelpers.ts:37-47`; `mutations.ts:163-175` |
| Copilot draft-first (explicit UNAPPROVED, comments the overload) | `src/copilot/tools/writeTools.ts:135` |
| DDL root of overload | `supabase/migrations/20260426000002_thu_chi_remove_approval_add_cancel.sql:12-21` |
| forfeit-settle propagation triggers, termination classify/guard | `20260710160000_recreate_forfeit_settle_trigger.sql:37`; `20260721135500:319`; `20260722150000_fix_forfeit_guard_false_positive.sql:97` |
| recurring-parent gate, commission uniqueness, layer-stats bucket, rollout gate | `20260603000010:80`; `20260709110000:77`; `20260704140000:59`; `20260721140500:131` |

### PROFIT consumers (recognition — decide deliberately at the chokepoint)

| Surface | Ref |
|---|---|
| 🎯 **fa_accrual_allocations (THE P&L chokepoint)** | `supabase/migrations/20260721080000_accounting_semantics_snapshot.sql:291/334` — `APPROVED + business_result_accounting IS DISTINCT FROM false + item accounting_class='PNL'`. CANCELLED/UNAPPROVED dropped. Original `20260626000000_fa_accrual_pnl.sql:79`. |
| fa_monthly_pnl / fa_monthly_pnl_accrual (inherit gate) | `20260702120000_kqkd_item_level.sql:164`; `20260626000000:170` (accrual wrapper carries NO predicate — inherits) |
| fa_type_breakdown / fa_accrual_allocations helper | `20260721080000:268, 334` |
| monthly_building_profit | `20260702120000_kqkd_item_level.sql:400`; tenant-aware `20260703162000:46` |
| invoice_pnl_cash_entries view (dashboard revenue) | `20260721102000_active_payments_reporting.sql:492` |
| shareholder scope-split, get_period_commissions_v2 ('paid'=APPROVED) | `20260701170000:231`; `20260710120200:88` |
| FE: useProfitVerification (documents the split explicitly), expense-ratio, useAccrualReport, ProfitDistribution*, ExpenseTab | `useProfitVerification.ts:80/86/122`; `realEstateReports.ts:557/587`; `useAccrualReport.ts:168`; `ProfitDistributionReport.tsx:275`; `ExpenseTab.tsx:64` |

**Must-fix summary:** the FE primary bug is `useCashBook.ts:45`; the SQL primary roots are `accounts_with_balance` (`20260704100000:51-59`) and the money-aggregate RPC trio (`20260710170000` + `20260610110000`). Every 🔴 above conflates approval with cash. The tooling that *certifies* money is also overloaded: `scripts/reconcile-money.mjs:128` (mandated by CLAUDE.md), `scripts/audit-accounting-rollout.mjs:159`, `scripts/doi-chieu-*.mjs` all hard-code `APPROVED='cash received'` and will silently mis-count post-split.

---

## 2. Writer class matrix

Every writer of `income_expenses`, its birth state today, the required Finance V2 birth state, and violation flags. Flags: **(a)** births APPROVED · **(b)** create-then-approve/post in one flow · **(c)** asks date/cashbook/image at source · **(d)** raw-DML fallback on 42501.

### TS writers (frontend)

| Writer | Ref | Birth today | §8.1 target / adapter | Flags |
|---|---|---|---|---|
| **useCreateIncomeExpense** (manual) | `src/hooks/income-expenses/mutations.ts:34` / raw fallback `:89-123` | Canonical `create_income_expense_v1`; **fallback INSERT sets NO approval_status → default APPROVED** | UNAPPROVED+UNPOSTED, atomic create primitive | a,c,d |
| useUpdateIncomeExpense | `mutations.ts:164` | 3-request header+delete+reinsert, no birth guard | atomic edit primitive | — |
| useQuickUpdateIncomeExpense | `mutations.ts:265` | RPC post-hoc account_id/attachments | cashbook/evidence at posting step | — |
| useImportIncomeExpenses (Excel) | `src/hooks/income-expenses/batch.ts:11` / `:39` | **raw INSERT, NO approval_status → APPROVED** | UNAPPROVED+UNPOSTED, no bulk auto-post | a,c |
| useCreateIncomeExpenseBatch | `batch.ts:104` / `:148` | **NO approval_status → APPROVED**; best-effort soft-delete rollback | UNAPPROVED; forbidden rollback | a,c |
| useCancelIncomeExpenseBatch | `batch.ts:233` / `:253` | raw bulk UPDATE→CANCELLED + delete payments | reversal/adjustment class | — |
| useUpdateBatchAccount | `batch.ts:303` | raw bulk account_id reassign | posting-axis mutation | — |
| useApproveVoucher | `statusMutations.ts:128` | canonical approve; **42501 correctly excluded** | LIFECYCLE approve | (d=NO ✓) |
| useUnapproveVoucher / useCancel / useRestore / useVerify | `statusMutations.ts:175,220,312,349` | RPC-first; cancel has raw legacy tail (`:256`) | reversal/review_state axis | — |
| **useSalaryPayout (WORST WRITER)** | `src/hooks/useManagerSalary.ts:834` / `:911, :1011, :985, :1034` | canonical `salary_payout_v1`; **on 42501→raw: expense voucher default-APPROVED + explicit-APPROVED rent-offset receipt + payment CT + stamps salary_monthly.paid** | one salary bundle parent pending; paid only from active posting | a,b,c,d |
| **useLockSalaryMonth** | `useManagerSalary.ts:656` / `:707` | canonical `lock_salary_month_v1`; **42501→raw UPDATE commission→APPROVED** (§8:850 forbids) | lock must NOT approve commission/create cash | b,d |
| useUnlockSalaryMonth | `useManagerSalary.ts:781` | canonical; 42501→raw (touches salary_monthly) | — | d |
| useDecideApproval (V2 engine) | `src/hooks/useApprovals.ts:59` | `decide_financial_request_v2` → POSTED | posting driver | — |
| useCreateCommissionVoucher | `src/hooks/useCommissionVoucher.ts:167` / `:175` | RPC, **UNAPPROVED ✓**; takes date/account at source | STANDALONE vs PAYROLL split; modal must NOT ask ngày/sổ | c (a=NO ✓) |
| useCreateProfitDistribution / useCreateManagerSalaryPayout | `src/hooks/income-expenses/specialized.ts:10, 50` | RPC, **fail-closed (no fallback) ✓** | HELD/CONSUMED/RELEASED/REVERSED reservation | (d=NO ✓ model) |
| useRecordPaymentRPC (invoice collection V5) | `src/hooks/useInvoicePayments.ts:21` | atomic `record_invoice_payment_v3`/V5 | **§8:827 sanctioned APPROVED+POSTED actual-cash exception** | c (permitted) |
| useRecordRefundRPC (misnamed — client DML) | `src/hooks/useInvoicePayments.ts:99` / `:163, :171` | **raw two-request, explicit UNAPPROVED ✓**; asks account+date | single atomic RPC → INVOICE_REFUND_OBLIGATION + refundable reservation; UI must NOT ask sổ/ngày | c (a=NO ✓) |
| useTerminateForfeit / useTerminateMoveOut | `src/hooks/useContractOperations.ts:185, 238` | RPC; forfeit pair pending; move-out asks receiptAccount+shortfallMode | NON_CASH pair; PAID mode risks auto-APPROVED extra_receipt | c |
| taoPhieuThuChiNhap (Copilot) | `src/copilot/tools/writeTools.ts:60` / `:134` | **raw, explicit UNAPPROVED+null account ✓**; two-request; idempotent | Copilot must call canonical RPC not direct DML | (a=NO ✓) |
| useUpdatePaymentMethod / useUploadPaymentReceipt | `useUpdatePaymentMethod.ts:135`; `useUploadPaymentReceipt.ts:72` | raw UPDATE account_id / attachments | posting-axis / evidence at post-time | — |
| pay_utility_bill / period-fee / handover / opening-adjust (FE wrappers) | `useUtilityBills.ts:238`; `usePeriodFees.ts:216`; `useCashHandovers.ts:133`; `useReconciliations.ts:68` | RPC server-owned | see SQL rows | — |

### SQL/RPC writers (system)

| Writer | Ref | Birth today | §8.1 target | Violation |
|---|---|---|---|---|
| **DB DEFAULT (root cause)** | `20260426000002:16` | `SET DEFAULT 'APPROVED'` | flip/remove; every writer must set birth explicitly | gate to enter SHADOW unmet until fixed |
| create_contract_v2 deposit receipt | `20260721090000_contract_create_v2.sql:814` | **APPROVED+real account in-RPC**; drives deposit_paid | dedicated actual-cash adapter; deposit_paid from posting; alias source→`contract.deposit` | births APPROVED |
| create_commission_voucher | `20260709110001:126` | **UNAPPROVED ✓**, `contract.commission` | system-obligation; STANDALONE/PAYROLL split | ✓ |
| move-out offset/revenue legs | `20260709100000_settlement_invoice_kind.sql:359, 367` | **APPROVED** (internal virtual) | NON_CASH+NOT_APPLICABLE pending, one pair request, materialize on approve | births APPROVED |
| move-out A/R payments | `20260709100000:345` | **CT payments settle invoices before approval** | defer to approve | cash-settle in source txn |
| move-out deposit/excess refund | `20260709100000:378` | **UNAPPROVED ✓**, account NULL, `termination.refund` | ✓ (voucher_date≠posted_on caveat; pure DEPOSIT must not hit P&L) | ✓ |
| move-out extra_receipt (PAID mode) | `20260709100000:403` | **APPROVED+real receipt in-RPC** | only V5/dedicated collection may post; else leave DEBT | births APPROVED |
| forfeit offset/revenue legs | `20260709100000:607, 616` | **UNAPPROVED ✓**, internal virtual | ✓ deferred to approve | ✓ |
| forfeit settle-on-approve payment | `20260721135500:1261` | CT payment on UNAPPROVED→APPROVED (later txn) | §6.8 pair = one approval subject | ✓ (guarded) |
| **record_invoice_collection_v5 (REFERENCE)** | `20260721100000:1251` | **APPROVED+payment+collection+tender+allocations in ONE txn** | the §8/§8.1 model actual-cash writer; one lineage per tender | reference ✓ |
| reverse_invoice_collection_v5 | `20260721100000:1652` | APPROVED, `reversal_of_income_expense_id` | reversal class ✓ | ✓ |
| record_invoice_payment_v3 (legacy) | `20260713160000:87` | **APPROVED, NULL system_source**; v4 RAISES when route=CANONICAL | pre-V5 mirror; the "three sources" hazard | births APPROVED |
| create_profit_payout_compat_v1 | `20260721150500:956` | **UNAPPROVED ✓**, reservation HELD; `profit.distribution` / `profit.manager_salary` | approve/post/cancel/reverse→HELD/CONSUMED/RELEASED/REVERSED | ✓ (source drift) |
| pay_utility_bill | `20260708110000:217` | **APPROVED+cash, business_result=TRUE** | pending recognized obligation; only Finance post moves cash | births APPROVED |
| create_opening_adjustment | `20260704150000:76` | **APPROVED direct**, business_result=FALSE | dedicated privileged posting/reversal writer, stricter reason/audit | births APPROVED |
| confirm_cash_handover | `20260701120000:315` | **APPROVED pair, NULL system_source** | dedicated privileged money op; stamp `handover.transfer` | births APPROVED |
| **useManagerSalary payout (client DML — NO RPC)** | `src/hooks/useManagerSalary.ts:909` | **default-APPROVED, NULL source** | one salary bundle pending; `salary.staff`/`salary.manager` | births APPROVED |
| **salary rent-offset companion (client DML)** | `src/hooks/useManagerSalary.ts:983` / `:1011` | **explicit APPROVED + payment CT, NULL source** | `salary.rent_offset` planned line of bundle | births APPROVED |
| **invoice refund (client DML — NO RPC)** | `src/hooks/useInvoicePayments.ts:149` | **UNAPPROVED ✓**, asks account, NULL source | atomic INVOICE_REFUND_OBLIGATION RPC; `invoice.refund` | c |
| terminate_*_with_credit_v1 wrappers (deferred credit) | `20260722160000:28`; `20260721135000:1602` | no direct IE insert; returns `{deferred:true}` when writer off | needs real queue/SLA | GAP |
| apply_customer_credit_v1 | `20260721135000:964` | does NOT touch income_expenses | keep out of cash/P&L; gate via feature route | ✓ |

**§8 gate blockers:** (1) DB default still APPROVED and actively exploited by `useManagerSalary.ts:909`. (2) Salary payout/rent-offset and invoice refund have **NO server RPC** — raw multi-request client inserts, uncoverable by any DB writer-class guard; the plan's `salary_payout_v1`/`lock_salary_month_v1` **do not exist as SQL**. (3) `isCanonicalFallbackSignal` (`src/hooks/income-expenses/canonicalFallback.ts:20`) treats **42501 as a coexistence fallback** — systemic §8:879 violation across create/salary payout/lock/unlock; only `isIeLifecycleFallbackSignal` (`:43`) correctly excludes it.

---

## 3. Source lineage / alias mapping

`voucherSources.ts` registers **18** sources (`src/lib/voucherSources.ts:29-50`) — NOT 20; the two "missing" slots correspond to un-added live canonicals. Three drift classes:

### Baseline → target `system_source` table

| Baseline (live writer emits) | Ref | Target canonical | In TS catalog? | Live writer? | Action |
|---|---|---|---|---|---|
| `contract.create.v2` | `20260721090000:827` | **`contract.deposit`** (§8.1:904) | target yes / baseline no | yes | ALIAS backfill + writer emits target after cutover |
| `profit.manager_salary` | `20260721150500:836` | **`salary.manager`** (§8.1:905) | target yes / baseline no | yes | ALIAS by manager/period/bundle id (don't infer from name) |
| NULL (staff payout fallback) | plan `:906` | **`salary.staff`** | yes | writes NULL (raw DML) | backfill NULL→`salary.staff`, drain raw writer |
| NULL (rent-offset companion) | plan `:907` | **`salary.rent_offset`** | **NO (both)** | none | NEW canonical to add |
| NULL (invoice refund) | plan `:908` | **`invoice.refund`** | **NO (both)** | none (client NULL) | NEW canonical to add |
| response-only (deferred forfeit) | plan `:909` | **`customer_credit.deferred_forfeit`** | **NO (both)** | none | NEW canonical + remediation-queue key |
| `invoice.collection.v5` | `20260721100000:1269` | unspecified — **DB_ONLY, not in §8.1 table** | **NO** | yes (high-volume) | decide: new canonical vs alias onto `invoice.payment` |
| `invoice.collection.reverse.v5` | `20260721100000:1666` | **DB_ONLY** | **NO** | yes | add to catalog (reversal legs won't group otherwise) |
| `fixed_fee` (period fee) | `20260708130200:132` | **DB_ONLY** | **NO** | yes | decide: fold under `utility.bill` vs distinct |
| `internal_settlement` | `20260713130100:30` (approval_rules key) | **orphan** — no voucher emits it; internal legs use `termination.*` | n/a | AUTO_POST rule likely never fires | reconcile approval-routing inventory |

### Catalogued-but-no-live-writer (backfill-only — new rows drift)

`invoice.payment`, `contract.deposit`, `salary.manager`, `deposit.reservation`, `handover.transfer`, `salary.staff`, `backfill.initial_deposit` are stamped ONLY by the one-time historical backfill `20260704110000`. Any code keying on these canonical names silently misses fresh data.

**Critical resolver gap:** the live P&L companion-pair resolver `20260721132500:595-596` still pairs `invoice.payment` ⇄ `contract.deposit`, but live writers now emit `invoice.collection.v5` and `contract.create.v2` → **new receipts+deposits can never form the historical pair** until the alias backfill AND resolver update land together. Unclassified sources render as "Nhập tay" with `isInternalSource=false` (`voucherSourceLabel`/`Group`); §8.1:898 requires one shared inventory where an unclassified source **fails Finance activation closed**.

---

## 4. RLS drop/rewrite list

PostgreSQL OR-merges all PERMISSIVE policies → a narrow CUSTODIAN/KNOWER policy changes nothing unless every broad policy is dropped in the **same transaction** per table (§9.1). **Live catalog (pg_policies), not migration files, is authoritative** — the schema_migrations ledger is unreliable (§4.1) and some policies were applied out-of-band.

### DROP_BROAD (voucher-visibility policies with no cashbook check)

| Policy | Ref | Table / cmd |
|---|---|---|
| accounts_select_staff (co-staff, `current_visible_owner_ids()`) | `migrations-archive/migrations-bundle/20260427_apply_staff_visibility.sql:104` | accounts SELECT — **out-of-band, verify in live catalog** |
| accounts_select_shared (`is_account_shared_with_me`) | `20260516000005:69` | accounts SELECT |
| income_expenses_select_rbac (building-only) | `20260527000054:85` (eff. `20260702150000:183`) | ie SELECT |
| income_expenses_insert/update/delete_rbac | `20260527000054:93,100,111` (eff. `20260703170000:128,110,100`) | ie I/U/D |
| income_expenses_select/insert/update/delete_all_buildings | `20260603000003:26,35,44,58` (eff. `20260703170000:157,145,138`) | ie all-building |
| **income_expenses_select_fund_member** (legacy CUSTODIAN analogue via `accessible_account_ids()`→UNIONs account_shared_users) | `20260601000001:18` (eff. `20260703161000:61`) | ie SELECT — shared user sees ALL vouchers |
| income_expenses_insert_shared (surviving write leak; its SELECT sibling already dropped) | `20260516000005:82` (eff. `20260703170000:164`) | ie INSERT |
| income_expenses_select_shareholder / _profit_manager / _salary_staff (exact-row-linked but OR-widen beyond cashbook) | `20260603000001:253`; `20260629000020:184`; `20260628000001:414` (eff. `20260703161000:86,80,92`) | ie SELECT — **AND with cashbook or drop; dropping outright breaks legit self-view** |
| income_expense_items_*_rbac / _all_buildings | `20260527000054:120,134`; `20260603000003:68` (eff. `20260703170000:280,254,240,325,305,294`) | items |
| account_shared_users_insert / _delete (direct-DML self-grant) | `20260516000005:57,62` | account_shared_users I/D |
| payment_receipts_select_authenticated (bucket-wide) | `20260601000200_sec_private_buckets.sql:43` | storage.objects SELECT |
| ie_attachments_select_authenticated (bucket-wide, OR-overrides folder-scoped) | `prod-snapshot/PS03_storage_shield.sql:449` (mirror `20260601000200:45`) | storage.objects SELECT |

### REVOKE_BASE_TABLE_SELECT (route via capability-scoped RPC)

| Table / policy | Ref | Replacement RPC |
|---|---|---|
| account_shared_users_select | `20260516000005:50` | `list_my_cashbook_access_v2` / admin RPC (drain to bindings) |
| approval_requests_select_member (org-wide, leaks payload_snapshot) | `prod-snapshot/PS01:2357` (origin `20260713130000:193`) | `list_my_pending_approvals_compat_v2` / `get_approval_request_detail_v2` |
| approval_request_steps_select_member | `PS01:2350` | RPC-only |
| approval_request_step_candidates_select_member | `PS01:2343` | RPC-only |
| approval_decisions_select_member | `PS01:2336` | RPC-only |
| approval_rule_sets_select_member (+ approval_step_approvers, authorization_audit_events from same loop) | `PS01:2365` | RPC-only |

### KEEP (RESTRICTIVE / platform bypass — but reconcile FOR ALL direct-DML with §9.3)

`accounts_hide_demo_admin` (`20260710140000:10`), `income_expenses_restricted_select/_update/_delete` (`20260613000000:214` — must be AND'd with new cashbook predicate, §9.2), `income_expenses_hide_demo_admin` (`20260710140000:112`), items restricted (`20260613000000:248`), owner-only `accounts_select/insert/update/delete` (`20251120000001:30-39`). The `*_super_admin_all` FOR ALL policies (`20260506000003:106`; `20260710150000:305`) grant direct base-table DML that §9.3 wants routed via RPC — keep read/bypass intent, reconcile the DML-revoke (break-glass decision). Note the `*_admin_all` (is_admin) counterparts were already dropped at `20260710150000:321`.

---

## 5. Access baseline

### `public.cashbook_possession_bindings` — ALREADY EXISTS

**Schema-source drift (§172):** DDL lives ONLY in `scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql:192`, NOT in `supabase/migrations/`. Generated row type at `src/integrations/supabase/types.ts:2405`. **Preflight must snapshot live pg_catalog before ALTER.**

**Current columns (PS04:192):** `id`, `organization_id`, `cashbook_id`, `membership_id`, `possession_kind`, `valid_from` (default `clock_timestamp()`), `valid_to` (nullable), `version` (bigint default 1), `granted_by` (nullable), `reason` (nullable), `created_at`. **This EXACTLY matches the §6.4 target — NO new columns needed (`version` and `reason` already exist).**

**What Stage-2 must ADD — only the KNOWER domain, across THREE constraints that must widen together:**
1. `cashbook_possession_bindings_possession_kind_check` `PS04:364` — `ANY(ARRAY['CUSTODIAN','OPERATOR'])` → add `'KNOWER'`.
2. `cashbook_possession_candidates_proposed_kind_check` `PS05:229` → add `'KNOWER'`.
3. `permission_definitions_possession_contract_check` `PS04:469` — pins `accepted_possession_kinds <@ {CUSTODIAN,OPERATOR}`; KNOWER permissions cannot be declared until widened.

Existing supports (free for KNOWER): open-kind unique index `PS04:567` (one open binding per org,cashbook,membership,kind), composite tenant FKs `PS04:369/374`, `valid_to>valid_from` CHECK `PS04:359`. **No append-only trigger** — only the unique index enforces one live row (§522 wants close-semantics).

**How CUSTODIAN is resolved today (no dedicated resolver):** the `possession` CTE inlined in `authorize_v2`/`authorize_tenant_action_v3` `PS04:979-1001` (dup in `PS01:1017-1020`): if `permission_definitions.requires_cashbook_possession` → require open binding whose `possession_kind ∈ accepted_possession_kinds` for the exact cashbook, interval-valid. Approval engine reuses bindings for CASHBOOK_APPROVER (`PS01:1507`) and self-approve (`PS01:1874`, raises 42501). **Target `assert_cashbook_access_v2`, `list_my_cashbook_access_v2`, `get_cashbook_access_admin_v2` DO NOT EXIST** (plan-only, §527/§753-754). CAS tables `cashbook_access_states`/`cashbook_access_mutation_requests` (§506) also do not exist.

**RLS/GRANT posture:** RLS on (`PS04:2763`); only SELECT policy is `cashbook_possession_select_super` (super-admin) so normal users read ZERO rows despite residual `GRANT SELECT TO authenticated` (`PS04:2861`, §967 wants it revoked). No client I/U/D policy (service_role only). Seed: `t5_20:73` inserted CUSTODIAN for each org owner across all cashbooks + auto-binds on new cashbook (`t5_20:186`). **Live audit: 32 open CUSTODIAN, 0 OPERATOR, 15 residual account_shared_users rows.**

### How `account_shared_users` currently grants (must DRAIN)

Table `20260516000004:16`: `(id, account_id→accounts, user_id→auth.users, created_by, created_at, UNIQUE(account_id,user_id))`. **NO possession_kind column; keys on auth.users NOT organization_memberships** → cannot auto-classify CUSTODIAN vs KNOWER; each of the 15 rows needs explicit per-row disposition. Three coarse grant paths, all coarser than KNOWER in BOTH directions:
- **accounts SELECT** — `accounts_select_shared` `20260516000004:78` (shared user sees whole cashbook in accounts list).
- **income_expenses SELECT** — `income_expenses_select_fund_member` via `accessible_account_ids()` `20260703161000:29-32` (shared user sees EVERY voucher, income AND expense — violates KNOWER income-only).
- **income_expenses INSERT** — `income_expenses_insert_shared` via `shared_account_ids()` `20260703170000:87-94` (shared user can insert income OR expense).

**Canonical resolver graph (KEEP):** `role_bindings` (`PS04:146`, authoritative ALLOW graph, DENY overrides possession §527-528), `role_binding_scopes` (`PS04:157`), `member_permission_overrides` (`PS04:163`, ALLOW/DENY diff layer). `staff_assignments` (`20250101000008:40`) is a legacy DRAIN source materialized once into role_bindings, kept in sync by `20260722140000_rbac_regrant_on_assignment_edit.sql:32` (a81 UPDATE trigger re-grants; a80 DELETE stays revoke-only — the 2026-07-20 lockout fix).

---

## 6. Balance/cash consumers → posting lines (§11.2)

All collapse to two roots: **(a) `accounts_with_balance` view** = `initial_amount + Σ APPROVED signed legs` (four correlated subqueries, `20260704100000:51-59`, **lifetime, no date bound**); **(b) money-aggregate RPCs** `cashbook_period_totals`/`cashbook_opening_balance`/`cashflow_by_day` (all hard-code APPROVED, keyed by `voucher_date`).

**Target formula:** `initial_amount + SUM(posting_lines.signed_amount)` with NO approval filter; period reports windowed by `posted_on` (NOT voucher_date). Repoint:

| Consumer | Ref | Change |
|---|---|---|
| accounts_with_balance view | `20260704100000:51-59` | 4 APPROVED subqueries → posting lines; `security_invoker=true` (run `check-view-invoker.mjs`); **also covers `change_amount`/`rounding_amount` legs (SECOND overload)** |
| cashbook_period_totals / opening_balance / cashflow_by_day | `20260710170000:154-194`; `20260610110000:46-56` | Σ posting signed_amount by `posted_on` |
| useCashBook / Summary / CashFlowByDay | `src/hooks/useCashBook.ts:45,97,157` | read posting lines |
| cashbook_settlement_report + useSettlementReport | `20260701130000:192-207`; `useSettlementReport.ts:65` | preserve `handover_transfer_id IS NULL` exclusion |
| propose_reconciliation | `20260701130000:82-102` | system_balance from posting; **historical snapshots immutable** |
| create_opening_adjustment | `20260704150000:57-96` | read posting balance; WRITE via dedicated posting/reversal writer |
| create/confirm_cash_handover | `20260701120000:117-137,249-351` | compute sweepable net from posting; emit posting pair |
| useRefundLog (Sổ tiền thối/Làm tròn) | `src/pages/payments/RefundLogPage.tsx:82-115` | posting lines for change/rounding legs; **ADD pagination (cap-1000 risk)** |
| useAccountsWithBalance + display | `useAccounts.ts:99`; `CashbookList.tsx:182`; `CashbooksMobilePage.tsx:41` | auto-correct once view repointed |

**Out-of-dimension (already on other axes — do NOT retro-fit):** `useDashboard.ts:124` (`invoice_pnl_cash_entries` P&L axis), `useRecentActivities` (`active_payment_receipts`).

**Risks:** two overloads feed the view (total_amount AND change/rounding — a total_amount-only migration silently zeros the two virtual refund books); handover exclusion must be reproduced or transfers double-count; the view is a hard dependency of THREE writer RPCs → cut-over must freeze/verify shadow balance per book (§10.5); `business_result_accounting=FALSE` transfer/adjustment legs need a "cash-but-not-profit" INTERNAL posting-line class.

---

## 7. P&L / profit-close / reservation (§6.7, §11.3)

**Single chokepoint:** every profit-close number flows through **`fa_accrual_allocations`** (`20260721080000_accounting_semantics_snapshot.sql:291/334`), which hard-codes `approval_status='APPROVED'` + `business_result_accounting IS DISTINCT FROM false` + item `accounting_class='PNL'`. CANCELLED/UNAPPROVED silently dropped. `fa_monthly_pnl_accrual` (`20260626000000:170`) is a pure wrapper inheriting the gate.

**Close pipeline (all inherit the gate):** `_profit_close_preview_core_v2` (current `20260720215000:15`; cross-checks `fa_monthly_pnl_accrual` `:246` vs `fa_accrual_allocations` `:263`, raises 55000 on disagreement); public `profit_close_preview_v2` (`20260721110000:363`); writer `_profit_write_close_v2` (`20260720210000:1317`; persists LOCKED `profit_monthly`, guards `source_hash`, raises 40001 on mismatch); `profit_close_v2`/`profit_reclose_v2` (`20260721110000:460`); RESET/UNLOCK `_profit_state_change_v2` (`20260720210000:1822`, snapshot-lifecycle only, no recompute).

**Reservation subsystem — the ONLY place the four-axis split already exists:** `_profit_allocation_reserved_v2` (`20260721120000:97`) counts:
- `LEGACY_BACKFILL` reservations off `voucher.approval_status IN ('UNAPPROVED','APPROVED')` (`:117-118`) — **overloads approval_status**;
- `CANONICAL_V1` reservations off `approval_requests.state IN ('PENDING_APPROVAL','POSTED')` (`:121-122`) — **already keyed off posting/approval-request lifecycle**.

**Verification gates:** `assert_profit_payout_fresh_v2` (`20260721120000:1092`), `assert_profit_payout_linkage_v2` (`:823`, homogeneous CANONICAL_V1 vs LEGACY_BACKFILL, mixing raises 55000), `profit_monthly_source_is_current_v1` (`:629`), and `transition_canonical_income_expense_v1` (`:1150` — writes `posted_at_v2` alongside `approval_status`, the seam the split widens).

**DRIFT RISK:** `current_profit_building_source_hash_v1` (`20260721120000:131/278`) **re-implements the accrual gate INLINE** rather than calling `fa_accrual_allocations` — two copies of `APPROVED + accounting_class=PNL` must stay byte-identical or staleness detection diverges from the P&L it guards. **Posting-invisible staleness:** if V2 lets posting change without changing approval_status, a locked snapshot's cash basis moves while its hash stays constant → `profit_monthly_source_is_current_v1` stays TRUE and a stale/over-reserved payout can post.

**§11.3/§6.7 decisions:** (1) Should `fa_accrual_allocations` keep keying on approval (accrual=authorized, posting drives only cashbook balance) OR switch KQKD gate to posting? This one function decides it for the whole pipeline. (2) Does CANONICAL_V1 become the sole reserved semantic post-cutover, retiring the LEGACY approval_status branch? (3) Refactor the hash function to CALL `fa_accrual_allocations` before V2 forces edits in two places. (4) CANCELLED handling once approval splits three ways. FE mirror `useAccrualReport.ts:168` already parameterizes approval (can show UNAPPROVED via ALL_ACTIVE) — a FE/SQL divergence that widens post-split. `useShareholderDistributions`/`useManagerSalaryPayouts` (`useShareholderProfit.ts:308,375`) treat APPROVED payout as "paid" → would over-report distributions.

---

## 8. Frontend surface (§12)

All 18 target files exist. Four axes to surface: **approval_status** (has UI), **review_state** (only `verified_at`→"Đã đối chiếu" + `IncomeExpenseVerifyDialog`), **posting** (FAKED client-side by `voucherLayer()`), **cashbook possession** (only owner + flat shared list).

**THE central overload — badge logic duplicated ~7×:**

| Location | Ref | String |
|---|---|---|
| **VoucherStatusBadge (shared)** | `src/components/income-expenses/VoucherStatusBadge.tsx:42` | APPROVED→**"Đã vào sổ"** (treats approval as cash-posted); UNAPPROVED→"Chờ duyệt" (`:30`); verifiedAt→"Đã đối chiếu" (`:37`); CANCELLED→"Đã huỷ" (`:22`); InternalBadge "Nội bộ" (`:48`) |
| VoucherDetailPage StatusBadge (local dup) | `src/pages/payments/VoucherDetailPage.tsx:43` | UNAPPROVED→"Nháp" (`:47`), APPROVED→"Đã ghi nhận" (`:48`) |
| IncomeExpenseDetailDialog | `src/components/income-expenses/IncomeExpenseDetailDialog.tsx:311` | "Đã huỷ" (`:305`)/"Nháp" (`:311`) |
| IncomeExpenseDetailMobile | `src/components/income-expenses/IncomeExpenseDetailMobile.tsx:263` | "Đã huỷ" (`:255`)/"Nháp" (`:263`) |
| IncomeExpenseMobilePage inline cards | `src/pages/payments/IncomeExpenseMobilePage.tsx:493` | "Đã huỷ" (`:486`), **"Chờ duyệt"** (`:493` — drift from desktop "Đã vào sổ"), "Nội bộ" (`:501`), "Đã đối chiếu" (`:509`) |
| IncomeExpenseBatchDetailMobile | `IncomeExpenseBatchDetailMobile.tsx:231` | "Đã huỷ" (`:227`)/"Nháp" (`:231`) |
| IncomeExpenseBatchDetailDialog | `IncomeExpenseBatchDetailDialog.tsx:375` | non-cancelled=="Đã ghi nhận" — **NO draft state** |
| IncomeExpenseBatchList | `IncomeExpenseBatchList.tsx:188` | all_cancelled→"Đã huỷ" else "Đã ghi nhận" |

**Posting axis faked:** `src/lib/voucherSources.ts:90` `voucherLayer()` synthesizes CASH/INTERNAL/PENDING from approval_status + virtual-account heuristics → drives layer tabs on `IncomeExpensePage.tsx:466` (default 'CASH' `:147`), `IncomeExpenseMobilePage.tsx:370`, and `IncomeExpenseStats.tsx:111` ("Bút toán nội bộ"/"Chờ xử lý"). Must repoint at `income_expense_postings` or double-count.

**Form / filter strings:** `IncomeExpenseForm.tsx:565` ("SỬA PHIẾU NHÁP", draft copy `:581`, `repeat_auto_approve` "phiếu con sinh dạng NHÁP" `:1166`, KQKD toggle `:927-959`). Filter enum `ALL_ACTIVE/APPROVED/UNAPPROVED/CANCELLED` string-coupled across `IncomeExpenseFilters.tsx:250`, `IncomeExpenseFilterPanel.tsx:39`, `IncomeExpenseFilterChips.tsx:44`, and `countActiveFilters` (`IncomeExpenseMobilePage.tsx:89`).

**Source modals** (approval↔posting wording): `CommissionVoucherModal.tsx:57` ("(nháp — chờ duyệt)", always draft), `PeriodCommissionModal.tsx:167` (**good reference** — "Lưu nháp: chưa vào sổ. Chi & duyệt: ghi tiền vào sổ ngay"), `RecordRefundDialog.tsx:200` (no status UI), `TerminateDialog.tsx:423` ("chờ duyệt" revenue), `ManagerSalaryPayoutDialog.tsx:112` ("Ghi phiếu chi" — appears to post directly, verify).

**Approval inbox:** `ApprovalsPage.tsx:76` (`list_my_pending_approvals_v1`, separate approval-requests table — approval axis, distinct from posting).

**Cashbook possession UI:** `CashbookForm.tsx:319` (owner + flat "Người được phép sử dụng" checkboxes — where CUSTODIAN/OPERATOR/KNOWER must be modeled), `CashbookDetailDialog.tsx:99`, `CashbookList.tsx:111`, `CashbookLockDialog.tsx:44`, `GeneralSettingsPage.tsx:361` (auto-approve threshold).

**Config settings:** `GeneralSettingsPage.tsx:361` ("Ngưỡng tự duyệt phiếu chi").

**DEAD CODE:** `IncomeExpenseListMobile.tsx` (exported, never imported — grep-confirmed; mobile page inlines cards). Updating it for §12 is likely wasted effort.

---

## 9. Rollout control-plane reuse (§10.4)

Finance V2 **registers into** the existing Accounting control plane (does NOT fork). Data plane in `scripts/authz-prepared/prod-snapshot/PS05_misc_remaining.sql`:

| Component | Ref | Reuse |
|---|---|---|
| `server_feature_flags` (mode OFF/SHADOW/CANARY/ON, release identity, caps, `config_version` CAS) | `PS05:171` (constraints `:309-329`) | Register 7 Finance keys as new ROWS (§10.4:1140) — do NOT create `finance_v2_org_config` |
| `server_feature_flag_canary_orgs` (per-org enrollment, PK feature_key+org) | `PS05:141` | reuse table |
| `server_feature_flag_operations` (append-only CANARY cap ledger, UNIQUE(feature_key,config_version,operation_key)) | `PS05:161` (`:299`) | reuse; count per config_version |
| `server_feature_flag_events` (append-only audit, immutable trigger `a00`) | `PS05:148` (`:12578`) | reuse |
| `evaluate_feature_route` → LEGACY/SHADOW/CANONICAL/FROZEN | `PS05:474` | reuse verbatim; Finance writers switch on same 4 values |
| `set_feature_route_v1` (CAS on config_version + release-identity regex) | `PS05:586` | Finance CAS transitions go through this (§10.4:1152) |
| `claim_feature_operation_v1` (atomic CANARY admission + cap append) | `20260721075000_accounting_canary_caps.sql:5` | **EVERY Finance canonical mutation at CANARY claims here** — create/approve/access amount 0, posting/reversal absolute (§10.4:1154) |

**Activation guard to MIRROR (not reuse):** `assert_accounting_feature_activation_v1` (`20260721140500_accounting_rollout_gate_v1.sql:322`) **hard-codes an Accounting-only allowlist at `:336` and RETURNs (passes) for any other key** → Finance keys are completely unguarded. Plan §10.4:1156/1158 requires:
1. NEW `assert_finance_v2_feature_activation_v1` + BEFORE trigger on `server_feature_flags` — mirror the guard pattern (`guard_accounting_feature_activation_v1` `:418`, trigger `a10_*` `:449`), namespacing the advisory lock (`'finance-v2-feature-rollout:'||feature_key`, cf. `lock_accounting_feature_rollout_v1` `:306`) with the same **row-lock-then-advisory** ordering to avoid deadlock against the Accounting trigger on the same table.
2. NEW `assert_finance_v2_canary_enrollment_v1` + BEFORE trigger on `server_feature_flag_canary_orgs` (mirror `guard_accounting_canary_enrollment_v1` `:454`, trigger `:490`).
3. Its own integrity oracles (template `count_invalid_payment_reversals_v1` `:6`) + a one-shot apply-time DO-block pre-assertion (template `:495`).

**Apply/validate/audit scripts to CLONE (separate manifest — do NOT append to the frozen 14-file `ACCOUNTING_MIGRATIONS`):**
- `scripts/apply-accounting-rollout.mjs:7` → `apply-finance-v2-rollout.mjs`: `Object.freeze` ordered array, `stripMigrationTransactionControl` (`:50`), `buildRolloutSql` (`:113`, BEGIN + `SET LOCAL lock_timeout='5s'`/`statement_timeout='15min'` + advisory-xact-lock DO on `'ihomecrm:accounting-rollout:v1'` → new Finance namespace + concatenated bodies + `NOTIFY pgrst` after COMMIT), sha256 digest (`:259`), `--dry-run`, forward-only Management API apply (`:187`, PAT from env/`CLAUDE.local.md`).
- `scripts/validate-accounting-migrations.mjs:15` → static + `--live-rollback` (`:38`, executes DDL then ROLLBACK `:130` for safe live-compile).
- `scripts/audit-accounting-rollout.mjs:29` → read-only POST-assertion (`BEGIN TRANSACTION READ ONLY` `:467`; `evaluateAuditReport` `:486` throws unless integrity counts all 0).
- Pre-assertion template `20260721070000_accounting_rollout_prerequisites.sql:8` (asserts schema owner, `ie_canonical_writer` role grants, ACLs, table ownership, constraint/trigger/function signatures + `prosecdef`/`proconfig` before apply).

**7 Finance V2 keys to register (§10.4:1142-1150):** `income_expense.workflow.v2`, `income_expense.posting.v2`, `cashbook.access.v2`, `income_expense.profit_close.v2`, `income_expense.read_semantics.v2`, `contract.commission.settlement.v2`, `salary.settlement.v2`. workflow/posting/access = one activation cohort locked atomically by NEW `set_finance_feature_cohort_v2` CAS wrapper (`:1182`); `read_semantics.v2` must be CANARY/ON BEFORE any workflow write (`:1184`); `profit_close.v2` FROZEN until read-safety CANONICAL (`:1188`). Accounting bundle digest to pin/replace: `801ca033e12fcd767260b00f64c784ef01783125625cca1a814de8beb993c4b5` (`:196`).

**ACL gotcha:** `CREATE OR REPLACE` preserves ACL only if the function pre-exists; every Finance migration touching control-plane functions must explicitly `REVOKE ALL FROM PUBLIC, anon` + `GRANT EXECUTE` to `ie_canonical_writer` (cf. `PS05:12692-12714`, §10.4:201). `force_freeze` is whole-feature emergency stop, NOT per-org — per-org/DEMO barriers route through a separate `finance_v2_backfill_runs` control row (§10.4:1012).

---

## 10. Divergences, risks & open questions

### Facts that contradict or refine the plan

1. **Posting axis is PARTIALLY live already.** `income_expenses` already carries `posting_id`/`posted_at_v2`/`reversed_by_posting_id` columns (prod snapshot `PS01`, 27 refs; `t5_08`/`PS04` exclude exactly these from frozen-column guards) and `transition_canonical_income_expense_v1` stamps them (`20260721120000:1213`) — even though the `income_expense_postings` TABLE does not exist. V2 must reconcile the pre-existing `posting_id` column/engine against the new table or risk two competing posting models. (writers-sql, approved-scripts, pnl open questions.)
2. **`voucherSources.ts` has 18 entries, not 20.** The two missing slots line up with un-added live canonicals (`invoice.collection.v5`, `invoice.refund`) — corroborating real drift, not a miscount.
3. **Salary payout & invoice refund have NO server RPC.** The plan's `salary_payout_v1`/`lock_salary_month_v1` do not exist as SQL; these are raw multi-request client inserts (`useManagerSalary.ts:909`, `useInvoicePayments.ts:149`) — the §8 "fallback raw DML caller count must be 0" targets, uncoverable by DB guards.
4. **`cashbook_possession_bindings` + `candidates` exist only in prod-snapshot SQL**, not `supabase/migrations/` — an ALTER targeting a table the local migration history never created. Must snapshot live catalog first (§172).
5. **Prod-snapshot `PS0*.sql` is a 2026-07-19 DR reverse-dump, NOT source-of-truth and NOT auto-regenerated** — a DR restore rebuilds PRE-V2 semantics. No `regen-prod-snapshot.mjs` exists. Any V2 schema change makes it stale immediately.
6. **`t5_15_invoice_force_cancel_v2_DRAFT.sql` is explicitly DRAFT/unapplied** — its force-cancel design must not be assumed live.
7. **Live P&L companion-pair resolver is already broken for new data** (`20260721132500:595-596` pairs retired `invoice.payment`⇄`contract.deposit`) — silent recognition gap until alias backfill + resolver update land together.
8. **`internal_settlement` AUTO_POST rule likely never fires** (`20260713130100:30`) — no voucher emits that source; internal legs use `termination.*`.
9. **Reconcile/audit tooling is itself overloaded** — `reconcile-money.mjs`, `doi-chieu-*.mjs`, `audit-accounting-rollout.mjs` hard-code `APPROVED='cash'` and will "certify" wrong totals post-split. CLAUDE.md mandates running `reconcile-money.mjs` on every money change → needs a posting-aware/dual-count mode.
10. **`t5_19`/`PS05:1056-1097` accrues `salary_monthly.paid` on approval_status entering/leaving APPROVED** — under posting split risks early/double accrual and asymmetric unwind.
11. **Deferred customer-credit is response-only** (`20260722160000:28` returns `{deferred:true}` with no queue row) — GAP; needs a real remediation queue/SLA (MEMORY: forfeit-guard fix left this writer disabled).

### Cross-cutting risks

- **OR-merge trap:** RLS narrow policy is inert unless every broad policy dropped in one txn (§4). `income_expenses_select_shared` SELECT already dropped but `insert_shared` survives — a CREATE-POLICY-only grep double-counts.
- **`accounts_with_balance` duplicated verbatim 5+ times** — patch the LIVE def and run `check-view-invoker.mjs` (CREATE OR REPLACE VIEW drops `security_invoker`, CLAUDE.md gotcha).
- **Same predicate = CASH in balance surfaces but PROFIT in fa_*/kqkd** — splitting posting will silently change P&L unless PROFIT surfaces are deliberately left on approval (or a new recognition flag).
- **Three constraints hard-code CUSTODIAN/OPERATOR** (`PS04:364`, `PS05:229`, `PS04:469`) — must widen for KNOWER in the SAME migration or KNOWER writes fail.
- **Two overloads feed the balance view** — a total_amount-only migration zeros the change/rounding virtual books.
- **Hash-gate drift** — `current_profit_building_source_hash_v1` re-implements the accrual gate inline (two copies must stay byte-identical).
- **15 residual `account_shared_users` rows** can't be auto-mapped to CUSTODIAN/KNOWER (no kind column, keys on auth.users) — needs explicit per-row disposition without breaking the balance-reconciliation guarantee `20260601000001` was written to fix.

### Consolidated open questions for Stage authoring

1. **§11.3 core decision:** does `fa_accrual_allocations` (`20260721080000:334`) keep keying accrual P&L on `approval_status`, or switch KQKD to the posting axis? One function decides it for the entire close pipeline.
2. **§6.7:** after cutover does CANONICAL_V1 (`PENDING_APPROVAL`/`POSTED`) become the sole reserved semantic, retiring the LEGACY `approval_status IN (UNAPPROVED,APPROVED)` branch?
3. Does `income_expense_postings` SUBSUME the existing `posting_id`/`posted_at_v2` columns, or coexist?
4. Should `invoice.collection.v5`/`.reverse.v5`/`fixed_fee` be NEW catalog canonicals or aliased? (§8.1 alias table omits them.)
5. Is the residual `GRANT SELECT ON cashbook_possession_bindings TO authenticated` revoked now (§967), making `list_my_cashbook_access_v2` a hard cutover prerequisite?
6. Do the gate-input tables the new activation guard must query (`finance_business_policy_decisions`, `finance_v2_backfill_runs`, `finance_v2_semantic_event_log`, posting/evidence/parity tables) land in an earlier Finance stage before the guard can be authored?
7. Are `cashbook_period_totals`/`cashbook_opening_balance`/`cashflow_by_day` layer-aware, or sum APPROVED-alone? (Needs a migration-side read — the FE sweep can't certify.)
8. Rendering model for §12: two badges (approval + posting) or one composite chip? Does `review_state` subsume `verified_at` or add a third badge?