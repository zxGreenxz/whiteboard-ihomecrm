# EXEC — Roadmap thực thi Thu Chi V2 (Finance V2)

> Companion thực thi cho `PLAN-THU-CHI-V2-DUYET-CHI-PHAN-QUYEN-SO-QUY.md`.
> File plan là **authority nghiệp vụ**; file này là **hợp đồng thực thi**: chốt ground-truth
> live, ghi mọi điểm plan lệch thực tế, chia phase có dependency rõ, và vạch **ranh giới
> tự động hoá có trách nhiệm**. Baseline: `origin/main`≈`d6837dd`, branch hiện tại
> `fix/v5-collection-completion-20260722`. Snapshot live: 2026-07-22 (project `tryymsxyyckgbrmmvozx`).

## 0. Ranh giới tự động hoá (đọc trước)

Toàn bộ **BUILD + verify trên DEMO** (`dddd0000-…0001`) chạy tự động, không hỏi lại. Hai lớp
bước **KHÔNG bypass**, chỉ stage tới sát mép rồi dừng chờ chủ dự án:

1. **§2.6 — 3 quyết định nghiệp vụ**: commission Sale (`STANDALONE`/`PAYROLL`), mốc phát
   sinh/clawback commission, chính sách cấn tiền phòng + nhiều đợt lương. Live **chưa có**
   `app_private.finance_business_policy_decisions` (bảng lẫn record). Schema sẽ **biểu diễn đủ**
   mọi lựa chọn, nhưng feature key `contract.commission.settlement.v2` + `salary.settlement.v2`
   giữ `OFF`; test/acceptance commission/salary chỉ finalize sau khi có decision record có
   actor/thời điểm/scope/version/hash.
2. **Cutover tiền thật production** (`aaaa0000-…0001`): mọi mode flip `SHADOW→CANARY→ON`,
   canary enrollment, cohort CAS, `force_freeze` trên org thật cần maintenance window +
   approval reference + operator, per §13/§20. Đây là thao tác khó đảo, đụng tiền thật ⇒
   chủ dự án bấm nút. Tôi build script + chạy dry-run/audit, không tự flip org thật.

Mọi thứ khác (13 stage migration, primitives/RPC, RLS, read models, frontend, test suite,
apply+verify **trên DEMO**, SHADOW/CANARY **trên DEMO**) tôi làm hết.

## 1. Ground truth live (đã đối chiếu 2026-07-22) & lệch so với plan

| Mục | Plan nói | Live thực tế | Hệ quả thực thi |
|---|---|---|---|
| `cashbook_possession_bindings` | "đã có ở `PS04` (app_private), CUSTODIAN/OPERATOR" | Tồn tại ở **`public`**, CHECK `CUSTODIAN/OPERATOR`; `app_private.cashbook_possession_candidates` cũng có | Stage-2 **expand `public.cashbook_possession_bindings`** (thêm KNOWER + version/reason nếu thiếu). Resolver mới `app_private.assert_cashbook_access_v2` đọc bảng public này. |
| Finance V2 objects | chưa triển khai | Xác nhận **0** object (posting/evidence/access-state/execution/business-policy/salary-tranche/semantic-log đều chưa có) | Greenfield hoàn toàn — không lo migrate object cũ. |
| `income_expenses.approval_status` | default `APPROVED` | ✅ default `'APPROVED'` NOT NULL | Birth-status bug xác nhận; chỉ đổi default sau khi mọi writer explicit state (Stage-12). |
| `approval_requests.state` CHECK | thiếu APPROVED/WITHDRAWN/CHANGES_REQUESTED/DISPUTED | ✅ live = `PENDING_APPROVAL,POSTED,DENIED,REJECTED,CANCELLED,REVERSED` | Stage-5 drop/recreate CHECK + thêm outcome cols + one-open index chỉ `PENDING_APPROVAL`. |
| Pending KQKD org thật | 15 phiếu / 132.221.200 | **22 phiếu / 157.177.238** (tăng) | Locked-period disposition queue **lớn hơn** tài liệu; phải re-inventory ở Stage-4, một phần thuộc kỳ khoá 05–07/2026. DEMO khớp: 7 / 612.000. |
| `account_shared_users` | 15 row | ✅ 15 | Drain nguồn legacy, không auto-nâng CUSTODIAN. |
| Rollout control-plane | tái sử dụng `server_feature_flags` | ✅ `set_feature_route_v1`, `evaluate_feature_route`, `claim_feature_operation_v1`, `assert_accounting_feature_activation_v1`, `server_feature_flag_canary_orgs`, canary caps đều live | Mirror pattern; guard Accounting **bỏ qua** Finance key ⇒ phải viết `assert_finance_v2_feature_activation_v1` + `assert_finance_v2_canary_enrollment_v1` riêng. |
| Reuse targets | `canonical_write_operations`, `income_expense_flow_ownership`, `termination_forfeit_authorizations` | ✅ đều live ở `app_private` | Expand additive, không tạo authority song song. |
| `schema_migrations` | dừng `20260716170000`, catalog có object 20260721–22 | ✅ đúng | **Không** dùng ledger/`db push`/`db reset` làm truth; pin catalog fingerprint. |
| Feature flags SHADOW | `customer.credit.apply.v1`, `shareholder_profit.distribute.v2` SHADOW | ✅ đúng | Deferred-credit queue (§6.11 wrapper) vẫn cần; profit v2 chưa CANONICAL. |

**Divergence quan trọng nhất:** possession bindings ở `public` chứ không `app_private`, và số
pending org thật tăng. Cả hai không đổi kiến trúc, chỉ đổi chi tiết Stage-2/Stage-4.

## 2. Nguyên tắc thực thi (bổ sung/điều chỉnh plan)

- **Manifest riêng, apply out-of-band**: `scripts/{validate,apply,audit}-finance-v2-rollout.mjs`
  mirror `apply-accounting-rollout.mjs` (lock `ihomecrm:finance-v2-rollout:v1`, single
  BEGIN/COMMIT/NOTIFY per file, sha256 per-file + bundle, dry-run `--live-rollback`, read-only
  audit + gate eval). **Không** thêm file vào `ACCOUNTING_MIGRATIONS` hay replay bundle 14-file.
- **Forward-only, ledger-agnostic**: migration mang timestamp `20260723HHMMSS_finance_v2_*`,
  áp qua Management API; không phụ thuộc `schema_migrations`.
- **Verify gate mỗi stage**: sau mọi stage đụng view → `node scripts/check-view-invoker.mjs`;
  sau mọi stage đụng tiền → `node scripts/reconcile-money.mjs`; static test kèm mỗi migration;
  `npm run typecheck:baseline` không tăng lỗi; `npx tsc --noEmit -p tsconfig.app.json`.
- **Ownership không overlap**: theo §17 (Agent 1–9). Khi fan-out bằng workflow, mỗi agent một
  file/domain, backend contract land trước UI, cash-owner ≠ P&L-owner.
- **DEMO-only writes** khi test browser/E2E; org thật read-only. Seed/cleanup fixture tự dọn.
- **Characterization trước schema** (§22.8): pin hiện trạng `approve→balance`, `cash=voucher_date`,
  shared-user visibility TRƯỚC khi đổi semantics; sau cutover thay bằng state/access matrix mới.

## 3. Chuỗi phase thực thi (dependency-ordered)

Ký hiệu: **[A]** tự động hoàn tất · **[D]** verify trên DEMO · **[G]** human gate.

### P0 — Foundation & inventory  **[A]** *(đang chạy)*
- Snapshot live catalog (xong), inventory workflow 12-reader (đang chạy): phân loại mọi
  `APPROVED` thành CASH/WORKFLOW/PROFIT, writer-class matrix, source-lineage/alias map, RLS
  drop-list, access baseline, balance/P&L consumers, frontend surface, control-plane reuse.
- Output: `docs/plans/EXEC-THU-CHI-V2-INVENTORY.md` (synthesis workflow) — precondition §22.5.
- Gate ra P1: inventory hoàn tất, không sửa code writer/migration trước đó.

### P1 — Characterization tests  **[A]** → commit 1 (`test(finance): characterize …`)
- `src/lib/__tests__/` + DB characterization: approve làm đổi balance (balance view SUM APPROVED),
  cash report dùng `voucher_date`, shared-user thấy toàn sổ. Giữ để so sánh; đánh dấu test sẽ
  đảo sau cutover (property approve/unapprove→Nháp trong `useIncomeExpenses.property.test.ts`).
- Không phụ thuộc inventory classification ⇒ có thể chạy song song P0 tail.

### P2 — Rollout scripts + manifest skeleton  **[A]**
- `scripts/apply-finance-v2-rollout.mjs` (+ export `FINANCE_V2_MIGRATIONS`, lock, digest, dry-run,
  pre/post assertion, forward-only Management API apply), `validate-`, `audit-` mirror accounting.
- Manifest 13 stage (rỗng ban đầu, fill dần). Static self-test: single BEGIN/COMMIT guard.

### P3 — Stage 1: semantics snapshot  **[A][D]** → commit 2 (phần 1)
- `*_finance_v2_semantics_snapshot.sql`: assert catalog/policy/writer/consumer baseline,
  ledger divergence, RBAC exceptions; output fingerprint khớp manifest. Static test
  `financeV2SchemaMigration.test.ts` (phần snapshot).

### P4 — Stage 2: schema-inert + activation guards  **[A][D]** → commit 2 (phần 2)
Trong **một** transaction: seed Finance/domain/read-safety feature keys `OFF`; private
global/org + business-policy attestation; cohort CAS; `assert_finance_v2_feature_activation_v1`
+ `assert_finance_v2_canary_enrollment_v1` + BEFORE triggers trên `server_feature_flags` &
`server_feature_flag_canary_orgs`; rồi tạo posting/lines/evidence/CAS/recognition-adjustment,
maker/birth provenance, salary bundle/authorization/tranche, expand `cashbook_possession_bindings`
(+KNOWER) + access-state/request, expand `canonical_write_operations`, approval compatibility
cols, profit reservation lifecycle; audit + semantic-event log; backfill run/change-log +
capture triggers (inert); header columns nullable; index/FK/constraint `NOT VALID`.
- **Không** để cửa sổ feature/enrollment chưa được guard bảo vệ.
- Verify: `check-view-invoker`, static test `financeV2SchemaMigration.test.ts`, DEMO
  `validate --live-rollback`.

### P5 — Stage 3: containment  **[A][D]** → commit 5 (phần leak)
- Đóng leak co-staff/all-building/storage; tạo `list_my_pending_approvals_compat_v2` + detail
  scoped; **revoke SELECT** approval base tables ngay. Chưa revoke money caller.
- Verify: RLS negative test (approval base read chặn), reconcile không đổi.

### P6 — Stage 4: backfill  **[A][D]** → commit 3 (phần 1)
- Consistent snapshot + `initial_watermark`; backfill V5-aware posting/recognition/access
  candidate; pending locked-period queue (re-inventory **22/157M** org thật, **7/612k** DEMO);
  RBAC repair candidates; exception tables. Repeatable/upsert, **không** UPDATE/DELETE posting event.
- Verify trên DEMO: exception review, balance parity SUM(lines)≈legacy.

### P7 — Stage 5: writers (primitives + RPC + state machine)  **[A][D]** → commit 4
- Private primitives §7.1 (resolve_actor, assert_cashbook_access, flow_owner, dispatch_decision,
  resolve_business_result, birth guards, create/approve/post/approve+post, review transitions,
  cancel, reverse, evidence register, access set, execution assign, reservation transition, pair
  adapters, refund/salary/deferred-credit adapters) + public RPC §7.2 + birth-XID guard +
  canonical idempotency + close-safety guard.
- Verify: DB/RPC state tests §16.2 trên DEMO (tạo→pending, duyệt→balance đứng yên, duyệt+chi
  atomic, retry idempotent, version conflict, revoke-during-lock, locked-period, reversal).

### P8 — Stage 6: system-writer adapters  **[A][D]** → commit 10
- V5 collection/reversal (change-only tender), contract deposit, recurring/batch/import,
  invoice refund obligation, deferred-credit resolver, utility, salary bundle/rent-offset/bulk,
  profit payout, handover, termination move-out pair + forfeit forward-fix, commission
  settlement-mode writer, Copilot. Commission/salary writer **stamp policy version** nhưng key `OFF`.
- Verify: adapter matrix §8.1 tests trên DEMO; source catalog parity.

### P9 — Stage 7: caller drain + ACL  **[A][D]** → commit 5 + 12 (phần drain)
- Chuyển caller cuối; `ie-create` fail nếu fallback; revoke direct DML/base-table access; drop
  broad money policies. **Legacy fallback count = 0** (điều kiện vào SHADOW).
- Verify: static scan writer, RLS negative, `financeV2FallbackSignal.test.ts` (`42501` không fallback).

### P10 — Stages 8–12  **[A][D]**
- 8 delta-catchup (change-log replay, tombstone, watermark, zero-lag), 9 shadow-reconcile
  (parity views/RPC, bypass monitor), 10 read-models (balance/cash/P&L/close, hash dispatcher
  versioned, V5 no-double-count), 11 RLS-canary (mode-aware safe policies/read RPC, private
  storage), 12 cutover-readiness (validate constraint/default/not-null áp được, set birth default
  `UNAPPROVED` sau khi writer explicit, readiness assertions). Migration này **không** đổi mode.
- Verify: reconcile per sổ/tháng, P&L tie-out, view invoker, RLS matrix §16.3 trên DEMO.

### P11 — Frontend  **[A][D]** → commits 6,7,8,9
- Contract/helpers (`types.ts`, `voucherSources.ts` `voucherLayer()` chỉ CASH khi posting active,
  `getVoucherDisplayState/Actions`), Thu Chi desktop/mobile, posting dialog dùng chung, badge/
  filter/stats/detail, approval inbox, cashbook settings (2 danh sách), account selector theo
  intent, source screens (bỏ Nháp/Chi & duyệt). Query key gồm org/access-intent/version.
- Verify: unit/property §16.4, regen types, typecheck baseline, E2E headless DEMO §16.5.

### P12 — Full test suite + DEMO SHADOW/CANARY  **[A][D]** → commit 11
- Static/DB-RPC/RLS/property/E2E đầy đủ; reconcile mọi kỳ canary DEMO; independent reviewer
  quét toàn repo (Agent 9), không còn finding High/Medium.
- **Trên DEMO**: read-semantics CANARY/ON → cohort workflow/posting/access CANARY → profit-close
  CANARY sau khi 52 unsafe locks + pending locked-period disposition sạch trên DEMO.

### G1 — §2.6 decisions  **[G]** *(chờ chủ dự án)*
- Trình 3 quyết định (recommendation kèm trade-off). Sau khi có decision record → finalize
  commission/salary writer/test, giữ key `OFF` cho tới enrollment.

### G2 — Production cutover  **[G]** *(chờ chủ dự án + maintenance window)*
- Org thật: barrier→final watermark→drain→audit→freeze close→read-semantics→cohort CANARY caps
  nhỏ→ON theo §20 step 15–18. Tôi chuẩn bị script/dry-run/audit; chủ dự án phê duyệt & flip.

### P13 — Contract cleanup  **[A]** *(release sau, sau ≥1 chu kỳ ổn định)*
- Stage 13 `*_finance_v2_contract_cleanup.sql`; đóng plan, chuyển contract vào tài liệu canonical.

## 4. Mapping phase → plan §13 stage → §17 agent → §18 commit → §16 test

| Phase | §13 stage | Agent | Commit | Test chính |
|---|---|---|---|---|
| P1 | — | 0/all | 1 | characterization, `useIncomeExpenses.property`, `profitClose` |
| P2 | manifest | 1 | (infra) | validate self-test |
| P3 | 1 | 1 | 2 | `financeV2SchemaMigration` (snapshot) |
| P4 | 2 | 1 | 2 | `financeV2SchemaMigration` (schema) |
| P5 | 3 | 3 | 5 | RLS approval-base revoke |
| P6 | 4 | 1 | 3 | backfill parity, exception |
| P7 | 5 | 2 | 4 | `financeV2Writer`, birth-guard, committed-birth-boundary, flow-owner, execution-queue, posting-subject, maker-identity |
| P8 | 6 | 8 | 10 | adapter matrix, source-catalog-parity, contract-deposit, termination move-out/forfeit, salary bundle/job-bonus, invoice-refund, commission-projection, customerCredit/forfeit post-bundle |
| P9 | 7 | 3 | 5,12 | fallback-signal, caller-drain scan |
| P10 | 8–12 | 1/3/4/5 | 6,7,11 | read-models, RLS matrix, delta/tombstone, reconcile |
| P11 | — | 6,7 | 6,7,8,9 | unit/property, E2E |
| P12 | — | 9 | 11 | full suite + reviewer |
| G2 | ops CAS | — | (cutover) | audit-finance-v2-rollout |
| P13 | 13 | 1 | 12 | cutover/contract |

## 4b. Quyết định chốt cho 8 open-question của inventory (không hỏi lại)

Nguồn: `EXEC-THU-CHI-V2-INVENTORY.md §10`. R = plan đã quyết; D = tôi quyết.

1. **[R] `fa_accrual_allocations` gate**: chuyển sang **trục recognition**, KHÔNG posting, KHÔNG
   coi APPROVED là cash. Base = `counts_in_business_result=true AND recognition_source_mode='BASE'`,
   **gồm pending UNAPPROVED chưa CANCELLED**, loại CANCELLED. Approve/post không recompute. Đây là
   `app_private.effective_profit_contributions_v2` (§11.3). Toàn pipeline close đọc resolver này.
2. **[R] Reservation semantic**: expand `profit_payout_reservations` thêm `reservation_state`
   (HELD/CONSUMED/RELEASED/REVERSED); replacement `_profit_allocation_reserved_v2` SUM chỉ
   HELD+CONSUMED; migrate LEGACY/CANONICAL_V1 branch vào reservation_state; bỏ đọc request enum
   như money truth (§6.7).
3. **[R] `income_expense_postings` vs cột `posting_id/posted_at_v2/reversed_by_posting_id` cũ**:
   bảng mới là cash truth canonical; **cột cũ giữ làm compat/provenance ONLY** — không FK vào event,
   không tính balance, không dùng làm `posted_on`. Pointer mới `active_posting_id_v2`. Cùng tồn tại;
   `transition_canonical_income_expense_v1` tiếp tục stamp cột cũ như compatibility (§6.1).
4. **[D] `invoice.collection.v5` / `.reverse.v5` / `fixed_fee`**: **thêm làm canonical MỚI** trong
   `voucherSources.ts` (khác lineage/reversal ⇒ không alias lên `invoice.payment`). `fixed_fee` giữ
   group "Vận hành". §8.1 alias table bỏ sót vì đây là *thêm* chứ không *alias*. Đồng thời **fix
   companion-pair resolver `20260721132500:595` lỗi sẵn** (pair `invoice.payment⇄contract.deposit`
   không match writer mới) — landing cùng alias backfill P6/P8.
5. **[D] Revoke `GRANT SELECT cashbook_possession_bindings TO authenticated`**: revoke ở **Stage-3
   containment**. An toàn vì chỉ policy super-admin tồn tại ⇒ authenticated đã đọc 0 row; read
   user-facing đi `list_my_cashbook_access_v2` (Stage-5).
6. **[R] Thứ tự Stage-2**: tạo **mọi gate-input table trước** (feature keys OFF, attestation,
   `finance_business_policy_decisions`, `finance_v2_backfill_runs`, `finance_v2_semantic_event_log`,
   posting/evidence/parity/access-CAS/recognition-adjustment/salary bundle), **guard cuối**, cùng
   một transaction ⇒ guard reference được bảng nó query (§13 stage 2).
7. **[D] `cashbook_period_totals/opening_balance/cashflow_by_day`**: hiện SUM APPROVED-alone (đã
   over-count internal/virtual legs — bug nhẹ sẵn có). P10 repoint sang `SUM(posting_lines)` theo
   `posted_on`. Đọc def live khi author P10 để xác nhận signature.
8. **[D] Rendering model §12**: **một composite chip** qua `getVoucherDisplayState()` trả đúng một
   nhãn canonical theo bảng §12.1 (approval × posting × execution). `review_state`
   (CHANGES_REQUESTED/DISPUTED) là **badge phụ** chỉ trong substate đó. `verified_at`→"Đã đối chiếu"
   giữ làm marker reconciliation **độc lập** (không thay posting).

## 4c. Supplement quan trọng từ inventory (bổ sung plan)

- **RLS drop theo LIVE `pg_policies`, không theo tên file migration**: một số policy áp out-of-band
  (`accounts_select_staff` ở `migrations-archive`). Stage-1 snapshot `pg_policies` live; Stage-3/9
  drop theo tên live. `income_expenses_select_shared` đã bị drop nhưng `insert_shared` còn sống ⇒
  grep CREATE-POLICY đơn thuần đếm nhầm.
- **Reconcile tooling tự nó overloaded**: `scripts/reconcile-money.mjs:128`, `doi-chieu-*.mjs`,
  `audit-accounting-rollout.mjs:159` hard-code `APPROVED='cash'`. CLAUDE.md bắt chạy reconcile mỗi
  money change ⇒ **thêm `scripts/reconcile-money-v2.mjs` (posting-aware / dual-count)** ở P10,
  không sửa bản cũ tới khi cutover.
- **3 constraint KNOWER phải widen CÙNG Stage-2**: `cashbook_possession_bindings_possession_kind_check`
  (`PS04:364`), `cashbook_possession_candidates_proposed_kind_check` (`PS05:229`),
  `permission_definitions_possession_contract_check` (`PS04:469`).
- **`accounts_with_balance` nhân bản verbatim 5+ migration + gánh 2 overload** (total_amount VÀ
  change/rounding legs): repoint phải giữ cả 2 nhánh, chạy `check-view-invoker.mjs` sau
  (CREATE OR REPLACE VIEW rớt `security_invoker`).
- **prod-snapshot `PS0*.sql` là DR reverse-dump 2026-07-19, KHÔNG source-of-truth, không tự regen**:
  không sửa file này; mọi thay đổi vào `supabase/migrations/`. DR restore sẽ rebuild pre-V2 (giới
  hạn DR đã ghi nhận). `cashbook_possession_bindings` DDL chỉ ở PS04 ⇒ Stage-1 assert tồn tại live
  trước khi ALTER ở Stage-2.
- **Salary payout / invoice refund KHÔNG có server RPC** (raw client multi-insert:
  `useManagerSalary.ts:909`, `useInvoicePayments.ts:149`): là target drain §8; P7/P8 phải **tạo mới**
  `salary_payout` bundle RPC + `reserve_invoice_refund_obligation_v2`, P9 drain raw caller về 0.
- **`isCanonicalFallbackSignal` coi 42501 là coexistence fallback** (`canonicalFallback.ts:20`) —
  vi phạm §8:879 hệ thống. P9 sửa để chỉ `isIeLifecycleFallbackSignal` typed-route mới fallback;
  42501 quyền thật phải fail. Gate SHADOW = raw fallback count 0.
- **`current_profit_building_source_hash_v1` copy inline accrual gate** (`20260721120000:131`): P10
  refactor gọi `effective_profit_contributions_v2`, tạo algorithm version Finance V2 mới
  (`profit-close-v2.2`?), snapshot cũ `profit-close-v2.1` vẫn verify bằng v1 (§11.3).

## 5. Trạng thái sống

- [x] P0 snapshot live + resolve possession/pending divergence
- [x] P0 inventory synthesis → `EXEC-THU-CHI-V2-INVENTORY.md` (49.9k, exact refs); 8 OQ resolved (§4b)
- [x] P2 `apply-finance-v2-rollout.mjs` + `validate-finance-v2-rollout.mjs` (audit deferred tới sau schema)
- [x] **P3 Stage-1** `20260723010000_finance_v2_semantics_snapshot.sql` — validated live-rollback
      (sha256 `3588d2fd…`), static test `financeV2SchemaMigration.test.ts` 7/7 xanh
- [x] **P4 Stage-2** `20260723020000_finance_v2_schema_inert_and_activation_guard.sql` (1880 dòng,
      18 bảng) — 6 fragment song song + assemble; validated live-rollback compose với Stage-1
      (`sha256 bee582ab…`); static test 18/18 xanh. Guards a11 + 7 feature keys OFF + KNOWER×3.
- [x] **P1** `financeV2Characterization.test.ts` 26/26 pin hiện trạng (voucherLayer/badge overload).
- [x] **P5 Stage-3** `20260723030000_finance_v2_containment.sql` (290 dòng) — drop leak theo tên
      live + compat approval RPC; static test 7/7.
- [x] **P6 Stage-4** `20260723040000_finance_v2_backfill.sql` (566 dòng) — **parity real-account
      EXACT (0 lệch)** validate trên live data; 7 NON_POSITIVE_TOTAL exceptions ghi nhận; static 7/7.
- [x] **P7 Stage-5** `20260723050000_finance_v2_writers.sql` (1789 dòng) — 11 RPC + 5 primitive +
      birth-XID guard + review state machine; static 7/7.
- [x] **P11a** `financeV2VoucherState.ts` (33/33) + **P10-audit** script (4/4).
- [x] **Stages 1–5 validate cumulative live-rollback** (`sha256 b6700e34…`); **102 test green**.
- [x] **P8 Stage-6** `20260723060000_finance_v2_system_writer_adapters.sql` (1345 dòng) — flow-owner
      dispatch + adapters (V5 tender/refund/salary/profit/termination-pair/deferred-credit/evidence);
      commission+salary policy-gated §2.6; static 6/6.
- [x] **P10 Stage-10** `20260723100000_finance_v2_read_models.sql` (417 dòng) — accounts_with_balance_v2
      (posting-based, security_invoker) + effective_profit_contributions_v2 + aggregate v2 + close
      blockers; additive; static 6/6.
- [x] **P11b posting dialog** `IncomeExpensePostingDialog.tsx` + `incomeExpensePostingValidation.ts`
      (22/22); TS baseline clean.
- [x] **Stages 1–6 + 10 validate cumulative live-rollback** (`sha256 cd70255e…`); **135 test green**.
- [x] **P9 Stage-7** `20260723070000_finance_v2_caller_drain_acl.sql` — revoke client DML + drop
      broad write policies (điểm-không-quay-đầu trước SHADOW; runbook phải verify caller=0 trước).
- [x] **Stage-8** `20260723080000_finance_v2_delta_catchup.sql` (agent draft salvaged) — a90 capture
      trigger + replay engine (reversal+replacement, không mutate event) + zero-lag gate.
- [x] **Stage-9** `20260723105000_finance_v2_shadow_reconcile.sql` (đổi slot 105000: parity views
      đọc read-models nên phải land SAU stage-10; manifest đã ghi chú) — balance/P&L parity +
      shadow summary + bypass monitor.
- [x] **Stage-11** `20260723110000_finance_v2_rls_canary.sql` (tự viết) — mode-aware posting-ledger
      RLS (CANONICAL + CUSTODIAN), §9.2 union predicate (KNOWER own-INCOME qua maker_user_id),
      intent selectors, admin/CAS access RPC (`cashbooks.share` qua `authorize_tenant_action_v3
      (…).allowed` — hàm trả TABLE, không phải boolean), execution queue.
- [x] **Stage-12** `20260723120000_finance_v2_cutover_readiness.sql` (agent draft salvaged) —
      VALIDATE CONSTRAINT + readiness report; default-flip để commented-out cho operator.
- [x] **`scripts/reconcile-money-v2.mjs`** — posting-aware, dual-count cap-1000 guard, verified
      pre-apply branch.
- [x] 🏁 **TOÀN BỘ 12-stage manifest validate live-rollback một lượt** (`sha256 7d058380…`);
      **145 test xanh / 11 file**; TS baseline sạch.
- [ ] Follow-up #2 semantic-event wiring bổ sung (Stage-8 đã append DELTA_REPLAY; Stage-4 baseline
      checkpoint còn thiếu); P11b FE integration (cutover); P12 DEMO forward-apply milestone.

**Lưu ý wave-5**: 5/6 subagent chết vì weekly limit (reset 7am) — 3 draft cứu được từ disk
(delta/shadow/readiness), Stage-7 + Stage-11 tự viết tay, reconcile-v2 từ agent duy nhất sống.

### FOLLOW-UPS bắt buộc xử lý TRƯỚC forward-apply (agent tự flag)

1. ✅ **RESOLVED — Stage-3 storage**: verify live cho thấy `can_read_storage_object_v1` (RESTRICTIVE
   `storage_pii_org_isolation`, PS03) đã org-isolate 2 bucket receipt qua `storage_object_links`.
   App đọc bằng signed URL (`createSignedUrlFromStored`) đi qua RLS ⇒ drop PERMISSIVE sẽ vỡ đọc
   hợp lệ mà không đóng thêm lỗ. Đã sửa Stage-3 GIỮ NGUYÊN storage; test cập nhật; re-validate xanh.
2. **Stage-4 chưa wire `finance_v2_semantic_event_log`** (source_kind='BACKFILL') và
   `finance_v2_backfill_runs` checkpoint → rollback-gate §10.4 chưa phân biệt mirror vs semantic
   write. Thêm baseline sequence quanh Stage-4.
3. **Stage-4**: 11 flow-owned POSTED voucher có posting event nhưng header stamp NULL (guard-frozen)
   → adapter Stage-6 phải stamp trước khi tighten NOT NULL. 7 NON_POSITIVE_TOTAL cần disposition.
4. **Stage-5 `resubmit`** chưa tạo approval_requests submission mới (chỉ header) → wire vào engine
   submit ở Stage-6. Runtime trigger-coexistence cần DB integration test (DEMO-apply).
5. **Stage-4 parity scope**: V2 balance reader PHẢI scope non-virtual account (virtual books = non-cash,
   không có posting). reconcile-money-v2 phải tie-out đúng phạm vi này.

**Apply model:** validate cumulative bằng rollback, KHÔNG persist gì vào catalog production trong
suốt build. Forward-apply Stage 1..N sẽ là một milestone riêng, được flag rõ, khi cần behavioral
test trên DEMO (RPC/backfill parity) — inert/reversible nhưng vẫn là ghi vào catalog chung.

*Cập nhật file này ở mỗi mốc; đây là nguồn trạng thái thực thi chính thức.*
