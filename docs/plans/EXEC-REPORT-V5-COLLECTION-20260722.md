# EXEC REPORT — Hoàn thiện V5 Collection (2026-07-22)

> Báo cáo thực thi bắt buộc theo plan §16. Cập nhật liên tục theo từng phase.
> Branch làm việc: `fix/v5-collection-completion-20260722` (từ `origin/main`).

## Commits nền

| Ref | Commit |
|---|---|
| `origin/main` (production, V5 client) | `7b33f8546bc69c1f78dc14ad51f5b199e91c4a60` |
| `05dce6e` (scope-narrowing, archived) | `05dce6ec55959b1ed4613c40d23f12a94c0dd0d1` → tag/branch `archive/accounting-scope-narrowing-05dce6e` |
| `origin/release/meter-domain` (bỏ qua) | `b449c3c7b26736394fc2988d065bd18946f5be2f` |
| Working branch HEAD sau Phase 1 | `7b43bf7` |

## Phase 0 — Preflight & baseline (DONE)

- Preflight: `origin/main` = 7b33f85 (khớp), `05dce6e` khớp; không thay đổi user lạ (chỉ plan doc). Branch `archive/accounting-scope-narrowing-05dce6e` @ 05dce6e + `fix/v5-collection-completion-20260722` @ origin/main đã tạo.
- Baseline trên nền V5: `typecheck:baseline` ✓ (31 fingerprint, no regress); `vite build` ✓ 25s.
- **P0 XÁC NHẬN**: client 7b33f85 gọi thẳng `recordInvoiceCollectionV5` (useInvoicePayments:43, useBulkRecordPayment:243, usePayments:202), RPC `record_invoice_collection_v5` RAISE `55000` khi route≠CANONICAL, mà `evaluate_feature_route('invoice.collection.v5', real|demo)` = **SHADOW** → luồng thu tiền vỡ nếu prod serve 7b33f85. (Web nhân viên đang tắt → không ảnh hưởng traffic thật; đi full plan.)
- Feature flags live: contract.create.v2=ON, invoice.record_payment.v1(V4)=CANONICAL, invoice.collection.v5=SHADOW, invoice.collection.reverse.v5=SHADOW, customer.credit.apply.v1=SHADOW, customer.credit.reverse.v1=ON, shareholder_profit.distribute.v2=SHADOW.
- Ledger `schema_migrations` mới nhất = 20260716170000 (bundle 2026072x apply out-of-band → DB object là chân lý).
- L03 live: INV total 4,816,667 − deposit 2,000,000 = P&L 2,816,667 (posted_pnl khớp). Profit: 52 unsafe locked (42 stale + 10 drift) → out-of-scope, giữ SHADOW.

## Phase 1 — Sync migration scope-narrowing (DONE, commit `7b43bf7`)

- Thêm `supabase/migrations/20260721150500_accounting_scope_narrowing.sql` — git blob **e5175538a116d5b4d274ac7cd4e285032b1a43c3** (khớp artifact đã duyệt; blob-identity ⇒ normalized SHA cũng khớp).
- Rollout scripts apply/audit/validate: pin **14** migration + bỏ shebang (để vitest import được).
- Port test `accountingScopeNarrowingMigration.test.ts` (10 test) — khoá semantics migration.
- CI `.github/workflows/supabase-migrate.yml`: **BỎ auto `supabase db push`** (tránh replay); push chỉ validation read-only + guard chặn auto-apply.
- **Gate xanh**: `validate-accounting-migrations.mjs` (14 migrations) ✓; vitest 33 test (scope-narrowing 10 + compat-guards 4 + rollout-scripts 19) ✓; `audit-accounting-rollout.mjs` live "Schema integrity audit passed" ✓; `typecheck:baseline` ✓.

## Phase 2 — Port matrix (DONE, workflow `wf_6cfd9a71`)

- 11 agent (7 analyzer + synthesis + 3 verifier), 0 lỗi. 35/35 file phân loại. 50 matrix rows, 24 port actions, 14 reject, 5 out-of-scope, 10 follow-up.
- **Verdict đối kháng**: `no-v4-leak` ✅ approved · `scope` ✅ approved (không kích hoạt credit/profit/payout ngoài phạm vi) · `completeness` ⚠ (chỉ thiếu ghi chú NO-OP cho `useUpdatePaymentMethod.ts` — đã fail-closed cho V5 qua `collection_id` guard; nhãn "§7.2 (9)" nên là (6)).
- Reject chính: paymentRecordRpc V3/V4 rewrite, recordInvoicePaymentWithFallback, classifyV4FallbackSignal, UI V4 fallback, paymentScopeNarrowing.test (ép V4), xoá customerCreditRpc/tests.

## Phase 4 — Client V5 (DONE, commit `4cb6238`)

- **Wave A** (checkout thuần cộng thêm từ 05dce6e): Account.organization_id, Invoice.organization_id + active_payment_methods, types.ts +3 Function (undo/update_method/create_profit_payout compat, type-only), test-accounting-chain migration.
- **Wave B** (workflow `wf_679f7cf0`, 4 implementer song song, file rời nhau):
  - credit fail-closed: useInvoicePayments (overpay CREDIT), useBulkRecordPayment (keep_as_credit), useInvoices (applied_credit) — chặn khi credit.apply.v1 chưa CANONICAL.
  - reverse legacy → `undo_invoice_payment_compat_v1` (paymentRecordRpc); collection giữ reverse_invoice_collection_v5.
  - org-scope sổ quỹ: useQuickCollect + CollectDrawer, RecordPaymentDialog, BulkRecordPaymentDialog.
  - RecordPaymentDialog: upload idempotent (409=ok) + started-attempt guard + disable credit checkbox.
  - SuperAdminForceDelete: gate paymentList.length===0 + giữ fail-closed.
  - Xoá CollectPaymentDialog (0 importer — verified).
- **Fix tích hợp**: InvoiceListTable TS2677 (bỏ predicate `is string` xung đột type mới); paymentRecordRpc.test cập nhật reverse→compat_v1; regen ts-baseline (31→30, bỏ entry file đã xoá).
- **Gate xanh**: no-v4-leak scan sạch (client), typecheck:baseline (0 lỗi mới), vite build 24.75s, 32 unit test.

## Phase 3 — NET-NEW DB migrations (IN PROGRESS)

- Prep §B1: contract RPC core đã đúng chuẩn live (secdef/search_path/ACL) → hardening = assert/test, không sửa RPC.
- Cơ chế rollout: migration set flag bằng direct UPDATE trong transaction có `lock_accounting_feature_rollout_v1` + attestation (commit_sha/migration_sha256/maintenance/approval); `set_feature_route_v1` CAS dùng cho thao tác vận hành + freeze.
- TODO: viết canary migration (SHADOW→CANARY, DEMO org, lock 2 flag) + activate migration (assert canary evidence + 0 incomplete → ON) + assert-test §B1/B2 + `scripts/freeze-v5-collection-rollout.mjs`.

## Phase 5–8 — (chưa bắt đầu)

_(cập nhật dần)_

## Phase 3 prep — Baseline contract §B1/§B5 (đã query, read-only)

Contract bảo mật RPC core (đã ĐÚNG chuẩn trên live → hardening chủ yếu là ASSERT/test, không sửa):

| Function | schema | secdef | search_path | ACL |
|---|---|---|---|---|
| `record_invoice_collection_v5` | public | ✓ | `pg_catalog, public, app_private` | postgres, authenticated |
| `reverse_invoice_collection_v5` | public | ✓ | `pg_catalog, public, app_private` | postgres, authenticated |
| `undo_invoice_payment_compat_v1` | public | ✓ | `pg_catalog, public, app_private` | postgres, authenticated |
| `record_invoice_payment_v4` | public | ✓ | `pg_catalog, public, app_private` | postgres, authenticated |
| `set_feature_route_v1` | app_private | ✓ | `pg_catalog, app_private` | **postgres only** (admin CAS) |
| `evaluate_feature_route` | app_private | ✓ | `pg_catalog, app_private, public` | postgres, ie_canonical_writer |

- `server_feature_flags` CAS key = `config_version` (bigint). Hiện: `invoice.collection.v5` cfg=4 mode=SHADOW, `invoice.collection.reverse.v5` cfg=4 mode=SHADOW. Activation = `set_feature_route_v1(key, expected_cfg=4, 'ON', caps..., commit_sha, migration_sha256, maintenance_window, approval_ref, actor, reason)`.
- **Chưa có** freeze/rollback function cho v5 → §12.4 `scripts/freeze-v5-collection-rollout.mjs` phải tạo mới.

## Phase 3 — Hardening + rollout scripts (DONE, commit `07faf5d`)

- `20260722120000_invoice_collection_v5_hardening.sql`: assert-only (secdef/search_path/ACL/balance invariant, không flip flag) + test 8 pass.
- `apply-v5-canary.mjs` / `apply-v5-activate.mjs` / `freeze-v5-collection-rollout.mjs`: CAS `set_feature_route_v1`, attestation đầy đủ, dry-run/rehearse ROLLBACK.
- **Dry-run validated trên DB thật**: canary dry-run PASS (DEMO=CANONICAL, real=LEGACY≠CANONICAL an toàn); freeze rehearse PASS (CAS fail-closed). Bug caught+fixed: postcondition real phải là "≠CANONICAL" (không phải "=SHADOW"), vì mode=CANARY + org không-enroll → LEGACY.
- 3 activation gate live = 0 (open exceptions / invalid reversals / unresolved payout). Incomplete canonical ops = 0.

## Phase 5 — Reports (DONE, no change)
- Verified: V5 base đã lấy P&L từ `accounting_class='PNL'`/`kqkd_amount`, không dùng gross. Không cần sửa.

## Phase 7 — CANARY LIVE (DEMO)

- `apply-v5-canary.mjs` REAL applied: `invoice.collection.v5` + `.reverse.v5` = **CANARY** (config_version 5), DEMO enrolled. `evaluate_feature_route`: DEMO=**CANONICAL**, real=**LEGACY** (org thật vẫn bị chặn V5). Reversible qua freeze/set SHADOW.
- **CÒN LẠI**: review + chạy test harness (910 dòng, `scripts/test-invoice-collection-v5*.mjs` + `scripts/lib/v5-collection-harness.mjs`) trên DEMO → reconcile → `apply-v5-activate.mjs` (real → ON) → push main.

## Phase 6/7 — Canary validation (IN PROGRESS)

- **§B7 GAP bắt được bởi canary** (giá trị thật của canary): `record_invoice_collection_v5` CHẤP NHẬN `overpay_action=CREDIT` dù `customer.credit.apply.v1` chưa CANONICAL. Client đã fail-closed (Phase 4) nhưng server chưa.
  → **Fix `01da720`**: trigger `a05_customer_credit_apply_gate` BEFORE INSERT trên `customer_credit_lots`, fail-closed 55000 trừ khi credit.apply.v1=CANONICAL. **Đã apply live + verify + test (5).**
- Harness `test-invoice-collection-v5.mjs`: record single/multi-tender ✓, CREDIT-reject ✓ (sau gate). Còn bug test-data (REFUND thiếu change_account_id) → 1 subagent đang green harness (chỉ sửa test bug, không nới assertion; dừng nếu gặp product gap).
- **CÒN LẠI**: harness xanh → reconcile 3 tháng → `apply-v5-activate.mjs` (real→ON) → push main + E2E fleet + audit.

## Commits (nhánh fix/v5-collection-completion-20260722, chưa push)
1. `7b43bf7` migration sync · 2. `4cb6238` client V5 · 3. `07faf5d` hardening+rollout scripts · 4. `01da720` §B7 credit gate

## Phase 8 — pending
- Commit test harness (khi xanh) + docs; push main; post-deploy E2E + audit.

