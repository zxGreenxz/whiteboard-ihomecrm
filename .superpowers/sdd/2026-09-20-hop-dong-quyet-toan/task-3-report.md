# T3 — Shared action policy and review-only transitions

Status: implemented for independent review; **not independently releasable**. T4 must wire the shared controller/context to Thu chi and settlement together. Base for this task's final diff: `cf90da46` (root's unrelated UI commits excluded).

## Delivered

- `src/lib/incomeExpenseActionPolicy.ts`: typed readiness for voucher, actor/org, scoped permissions, workflow/posting routes, actual ownership/source capability, custody and cancellation; every action returns visibility, enabled/loading and a reason/code. Commands are separate. Canonical approve-only, legacy approval, atomic approve/post, post-only, reverse, unapprove, cancel, financial edit, supplement, request changes and resubmit are distinct.
- `src/components/income-expenses/IncomeExpenseList.tsx`: consumes that policy. New optional `actionContexts[id]`, `onApproveOnly`, `onApproveAndPost`, `onRequestChanges`, `onResubmitReview`. Existing `onApprove` is explicitly legacy (can change cash). Missing complete context keeps applicable actions visible and disabled; no route/ownership/CAS/custody guesses. Old cancellation props are compatibility-only and deprecated; their truth must enter the shared context.
- New SQL migration `20260920182530_shared_income_expense_review_transitions.sql`, name allocated by the repository generator, preserving existing RPC signatures. New private helpers are not executable by client/service roles. Public RPCs are authenticated-only, VOLATILE/SECURITY DEFINER with protected search paths.
- Real local PostgREST JWT integration test in `scripts/test-income-expense-review-local.mjs`. Fixed loopback-only runtime, generated isolated orgs/users/rows, fixture cleanup; it never uses service-role JWT. DB owner is used only for schema/fixture setup and inspecting invariants. Direct-SQL denial probes run as `authenticated` with claims.

## Backend semantics and reproduced blockers

`request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)` still needs scoped `income_expenses.approve`; PENDING/DISPUTED → CHANGES_REQUESTED. `resubmit_income_expense_v2(uuid,bigint,jsonb,text)` returns the existing CHANGES_REQUESTED voucher to PENDING. A non-NULL maker must be the original maker; a NULL maker requires scoped `income_expenses.edit`. Neither operation changes maker. Both require active membership/org, building access, restricted/demo visibility and the existing owning-adapter guard. Request/resubmit do not add an approval request, approve, post, create a replacement voucher or edit source items.

Authorization and owner/source checks precede an idempotency replay. Missing/negative expected review version is 22023; stale CAS is 40001. Nonempty `p_patch` is rejected with 22023, since the old function hashed it without applying it. Callers should pass `{}` or SQL NULL and supplement separately. Existing operation names, payload hashes, result fields, audit events and approval-request closure are retained.

Three local failures were reproduced before fixing:

1. NULL-maker legacy voucher + scoped editor → 42501.
2. Canonical-owned original-maker voucher with `change_field_mask` → freeze 55000.
3. Once review succeeded, a86 birth bridge silently stamped missing `birth_operation_id`, `birth_txid`, `source_payload_hash` **after** the freeze trigger. Whole-row invariant tests caught this.

The shared private operation predicate requires lifecycle token + open request/resubmit canonical operation in the same transaction, org, subject and actor. The freeze branch checks only the five review fields and exact transition/version increment before legacy early-return. The birth bridge skips stamping only during that same review operation on UPDATE; INSERT and all other lifecycle paths retain existing behavior. The RPC checks the final persisted header again, protecting against later BEFORE triggers. Original and final pg_get_functiondef hashes are checked: reapplying the exact migration works; unrelated definition drift stops it.

Review permits CASHBOOK/UNPOSTED and NON_CASH/NOT_APPLICABLE, with no active posting, and UNAPPROVED status. It preserves ID/code/amount/source/items/maker/approval/posting/birth metadata. Existing source, period, reservation and other guards are not disabled.

## Ownership / source audit

Read current local catalog definitions captured from the audited runtime and corresponding repository sources:

| Source / writer | Actual ownership detail | T3 review |
| --- | --- | --- |
| `create_commission_voucher` | Direct INSERT; no flow ownership claim. `BROKER_COMMISSION` is its special fee autopay argument, not an ownership value. | Existing unowned broker vouchers supported; no creation/autopay change here. |
| `create_sale_bonus_from_deposit_v1` | Direct INSERT; `SALE_BONUS_DEPOSIT` is a private flex-write **scope**, not a claimed flow kind. | Existing unowned sale vouchers supported. |
| `create_termination_refund_voucher_v1` | Direct INSERT; no flow ownership claim. | Existing unowned termination refunds supported. |
| `reserve_invoice_refund_obligation_v2` | Explicit flow_kind `INVOICE_REFUND` or `TERMINATION_REFUND`, lifecycle_owner `INVOICE_REFUND`. | Review denied: no safe shared review dispatcher audited. T6/T6R capability gap. |
| Canonical manual writer | flow_kind `CANONICAL_INCOME_EXPENSE` | Supported with existing owner guard. |
| Reservation settlement sources/legs or reservation refund/forfeit system sources | Additional reservation source guard, even with no ownership row. | Explicit unsupported reason/42501; no bypass. T6R gap. |
| Other actual domain ownership | Existing assert rejects noncanonical owner. | Explicit unsupported reason; no category-specific bypass. |

`decide_owned_income_expense_v2` exposes approve/cancel for INVOICE_REFUND/TERMINATION_REFUND; policy preserves that approve-only dispatcher. Current local `approve_and_post_income_expense_v2` and `post_approved_income_expense_v2` both assert CANONICAL_INCOME_EXPENSE and have no owning dispatcher fallback; those domain-owned cash actions remain explicitly unavailable. Existing **unowned** broker/sale/termination are not categorically blocked.

Relevant source definitions: `20260902100049_ten_phieu_hoa_hong_theo_phong_va_ghi_chu_luc_xem.sql`, `20260820090000_sale_bonus_deposit_account_attachments.sql`, `20260828090000_termination_refund_writer_hardening.sql`, `20260731070000_current_date_to_org_today.sql`, `20260724180000_finance_v2_refund_decision_entrypoint.sql`, `20260909172332_reservation_deposit_settlement_v1.sql`.

## T4 context / command handoff (required before release)

API: `decideIncomeExpenseActions(context: IncomeExpenseActionContext)` and `pendingIncomeExpenseActionContext(handlers, display?)`; `display` is only a nonauthorizing visibility hint. There is no complete generic snapshot hook in this T3. T4 must provide one shared selected-voucher snapshot/context builder to **both** finance and settlement, rather than querying N+1 snapshots for every rendered row.

Required data dependencies:

- Authenticated selected voucher: id, organizationId, buildingId, type, userId, actual nullable makerUserId, approvalStatus, postingStatus, postingMode, reviewState, activePostingId, accountId and nullable actual review/approval/posting versions. Never derive version 1 from missing data. Scope must match the selected org and voucher; stale/cross-row snapshots must not authorize another row.
- Actor and active selected org/admin readiness; scoped approve/edit/cancel via the same building scope as the server. No use of global `canUse` as a building decision.
- Strict current routes: existing `useFinanceV2Routes` silently converts RPC failures to LEGACY and is insufficient as a write-authority source. Fetch/parse errors must be represented as error/loading, including route changes while a dialog is open. FROZEN never falls back to legacy.
- `flow_kind` from actual ownership, not T2's `lifecycle_owner` display field; reservation source/leg lookup; real money-edit eligibility. Absence is different from failed/missing lookup.
- Successful cashbook/custody queries (not existing null/[] fail-open wrappers). `hasUsableCashbook` means at least one actual eligible book; `holdsVoucherCashbook` means the selected actor holds the voucher's actual book. Post-only needs custody, not approval permission. Reverse needs that exact book.
- Successful income/flex cancellation reader result with its denial reason and writer selection; undefined is loading. Preserve useIncomeDoor/useFlexWriter/mode. Flex cancellation needs both real versions.
- Actual command availability (List intersects context handlers with installed handlers). Controller must re-read at dispatch and must not fall back to an alternative money command after a denial. Unapprove/legacy approve need actual approval CAS; their old hooks' undefined-CAS fallback must be tightened in T4 on both surfaces.

The new backend review RPC signatures are unchanged and no generated type was edited. T4 should put their typed invocation/mutations/invalidation in the shared commands, never in view components. Supplement remains append-only and does not change review state. Policy retains the prior narrow annotate rights (creator/admin/edit); server append permission is broader through cashbook rights. T3 does not silently expand the client permission.

Birth readiness remains a T4 context extension/gap: the review fixture proves missing birth stays missing. Current canonical approve's `assert_committed_birth_boundary_v2` suggests it could reject such a fixture, but this task did **not** execute a complete approve/legacy-adoption flow to prove that runtime outcome. Inspect existing shared adoption/birth machinery before deciding capability. Never backfill via review. Root's read-only live aggregate at 2026-09-20T18:54:44Z found zero missing birth fields among THẬT pending broker43/sale8/termination41 and DEMO pending termination3; this proves presence only, not a valid committed chain or approval authorization. The synthetic missing-birth case is not evidence that all live legacy rows are blocked.

## Verification

- TDD red: missing policy module; List still hid/optimistically gated actions; backend maker-NULL 403; canonical mask freeze; late birth stamping. Additional policy guards failed first for missing unapprove/legacy CAS, pending active posting and unsupported owned post, then passed.
- Final focused run: **51 tests / 5 files passed** (`incomeExpenseActionPolicy`, `IncomeExpenseListActions`, existing financeV2 characterization, status mutations and supplement tests). New policy23 + List2.
- `tsc --noEmit -p tsconfig.app.json`: exit0 (after correcting the List test pagination fixture). `git diff --check`: clean. RPC-in-view and RPC-layer gates: passed, no new view RPC.
- Local PG17/PostgREST16.3 authenticated JWT review loop: PASS, including NULL-maker scoped editor, original maker, canonical ownership/mask, unowned broker/sale/termination, NON_CASH, original or missing birth, source item preservation, exact identity/amount/code/source/maker/approval/posting, and zero cash/birth operations.
- Denials: wrong org/membership/building, restricted voucher, named-maker mismatch, missing permission, suspended org/membership, unsupported owner/reservation, posted/active-posting/approved/cancelled state, invalid/stale CAS and nonempty patch. Two concurrent keys/same CAS produce exactly one success. Both request and resubmit replay are denied after their required permission is revoked.
- Private helper/token/op forgery denied to authenticated SQL. Direct authenticated money mutation denied. The real birth trigger's INSERT branch tested on a session-temp row-shaped probe: it still stamps birth. Direct base-table INSERT exposed an unrelated existing invoker profit-lock schema ACL, so it was not treated as the application's create-RPC test; source creation remains T6.
- Exact migration reapplied twice; deliberately altered freeze/birth/resubmit definitions rejected as drift and rolled back. Catalog confirms public authenticated-only ACL and private helpers owner-only, explicit protected search paths, VOLATILE.
- `scripts/dot-bien.mjs`: auth removal changed SHA256 `a568fa7acb36→796c8328d5cf`, caught by revoked-authority replay denial; money mutation `a568fa7acb36→180a5084171a`, caught by review freeze. Both helper exit0, source digest restored, audited public definitions and final migration reapplied locally, final JWT suite PASS.

No shared Supabase schema/data apply, no THẬT writes, no deployment or PR. No browser/E2E claim. Controller owns generated types, staged migration provenance generation, source/ACL/sandbox/reconcile gates, full build/regression, independent reviews and release checks after schema tasks. Source dispatcher gaps and T4 simultaneous wiring remain release blockers.

## T3 review fix round 1

Đã sửa đúng ba Important trong `task-3-review.md`, bắt đầu từ `b4483a24`. Root commit Events UI độc lập `d14ac0f4` trong lúc kiểm thử; diff sửa T3 chỉ có policy, hai file covering tests và báo cáo này.

- Context bắt buộc có `permissions.reverse` theo scope tòa nhà. Reverse kiểm permission readiness và quyền `income_expenses.reverse` riêng trước custody; thiếu quyền trả PERMISSION, đang tải/lỗi giữ LOADING/READ_ERROR. T4 snapshot builder phải cấp thêm field này.
- Reverse chỉ hỗ trợ owner NULL hoặc CANONICAL_INCOME_EXPENSE như writer hiện tại; INVOICE_REFUND/TERMINATION_REFUND POSTED bị chặn với SOURCE_WRITER_UNSUPPORTED. Không thêm dispatcher.
- Approve-and-post chỉ nhận UNPOSTED; post-only vẫn nhận APPROVED + REVERSED khi đủ custody và không cần quyền approve/reverse.

Kiểm chứng: đối chiếu guard nguồn ở `20260723050000_finance_v2_writers.sql` (reverse owner/quyền tại 1710–1715; approve-and-post UNPOSTED tại 1132) và bằng chứng catalog read-only của reviewer. Thêm 10 ca covering tests: lần RED chạy `npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/incomeExpenseActionPolicy.test.ts` có 6 failures đúng ba finding, 27 pass. Sau sửa chạy `npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/incomeExpenseActionPolicy.test.ts src/components/income-expenses/__tests__/IncomeExpenseListActions.test.tsx`: **35/35 pass**. `npx --yes --package=node@24.18.0 node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`: exit0. `git diff --check`: sạch. SQL và local JWT harness không đổi, không chạy lại theo phạm vi vòng sửa; các giới hạn tích hợp T4/T6 đã ghi ở trên vẫn còn.
