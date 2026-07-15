# Authorization tranche `T5` — Canonical writers per domain (flags default OFF)

> Trạng thái: `IN_DESIGN`
> Production mutation / canary / flag flip: **BLOCKED** — không được apply khi thiếu bất kỳ trường bắt buộc ở §2, khi recovery chưa `VERIFIED`, hoặc khi owner chưa ra lệnh riêng cho đúng domain-slice (SHA + migration SHA-256 + maintenance window + canary count + VND cap). Default khi chưa chốt: canary = `0`, VND cap = `0`, mọi flag = `OFF`, không apply/flip.

Nguồn chuẩn nghiệp vụ: [AUTHORIZATION-PLAN.md](../AUTHORIZATION-PLAN.md) mục 27 (đặc biệt 27.2 quyết định owner, 27.4 cutover theo domain). Tracker runtime: [AUTHORIZATION-IMPLEMENTATION-STATUS.md](./../AUTHORIZATION-IMPLEMENTATION-STATUS.md) (T5 = `BLOCKED`). Tài liệu này KHÔNG phải migration được duyệt; SQL chỉ xuất hiện dưới dạng code block minh hoạ contract, không được đặt vào `supabase/migrations/`.

---

## 1. Scope và dependency

- **Deliverable/tranche ID:** T5 — Canonical writers theo domain, callable grant review riêng, flag mặc định OFF (plan 27.3/27.5 dòng T5).
- **Domain:** invoice (create/edit/approve/lifecycle), payment reversal (thu tiền hoàn tác), income/expense voucher (thu-chi), meter reading, deposit/contract create + first-invoice, salary/profit payout. Payment *collect* (single + bulk) KHÔNG thuộc T5 — đã tách sang T1b (`record_invoice_payment_v3`).
- **Normative plan section:** mục 27.2 (quyết định 1–8), 27.4 (8 bước cutover theo domain), 27.6 (cửa GO tối thiểu).
- **Dependencies và trạng thái (bắt buộc `VERIFIED` trước khi T5 rời `IN_DESIGN`):**
  - T0a recovery — `BLOCKED` (ONLINE_UNFROZEN/PARTIAL). Gate cứng: không apply bất kỳ domain-slice nào khi recovery chưa `VERIFIED`.
  - T1a containment approval RPC — `BLOCKED`.
  - T1b `record_invoice_payment_v3` hardening — `BLOCKED`. T5 reversal/payout tái dùng contract collect của T1b nên phụ thuộc trực tiếp.
  - T2 RBAC source-of-truth + authorization-version — `BLOCKED` (permission `hoa_don.*`, `thu_chi.*`, `luong.*`, `cong_to.*`, `hop_dong.*` chưa chuẩn hoá).
  - T3 approval contract v2 (maker-checker, self-limit, held cashbook, reversal) — `BLOCKED`. Mọi phiếu chi force-approval + self-approve sub-limit của T5 phải chạy qua engine T3.
  - T4a harness (two-org JWT, concurrency, full-domain reconciliation, writer map) — `IN_DESIGN`. T5 không có evidence hợp lệ nếu thiếu harness này.
  - T6a organization integrity + RLS v2 shadow — `BLOCKED`.
- **In scope:**
  - Thay từng writer trực tiếp bằng **RPC canonical `SECURITY DEFINER`** server-derive organization/actor/resource, exact permission, state/version guard, atomic multi-effect, append-only audit — mỗi domain một RPC, đặt sau **feature flag mặc định OFF** (client giữ đường cũ tới khi flip theo canary).
  - Server-enforce quyết định owner 27.2 tại canonical layer: (1) invoice create mặc định `APPROVED` chỉ khi setting tổ chức `auto_approve_invoice` bật, ngược lại `DRAFT`; (2) edit invoice `APPROVED` chưa payment qua locked revision `expected_version + reason + before/after audit`; (3) payment reversal = bút toán đối ứng liên kết, **không hard-delete**; (4) maker-checker + self-limit exception dùng held cashbook; (5) maker chỉ chọn cashbook đang giữ, phiếu chờ được để trống cashbook; (6) hold cọc 24h server-time `expires_at`, no double-hold; (7) bulk payment per-invoice atomic partial success (đã ở T1b, T5 chỉ đảm bảo không còn writer song song).
  - Regen `src/integrations/supabase/types.ts` sau mỗi migration đổi schema; chạy `node scripts/check-view-invoker.mjs` nếu đụng VIEW; `node scripts/reconcile-money.mjs` cho mọi slice đụng tiền.
- **Out of scope:**
  - Payment collect single/bulk (`useRecordPaymentRPC`, `useBulkRecordPayment` → `record_invoice_payment_v3`) — thuộc T1b.
  - Revoke direct DML / RLS v2 write-cutover / drain writer cũ — thuộc T6b/T7, apply sau khi T5 canonical đã canary `VERIFIED` từng domain.
  - Storage/R2/Edge ACL — thuộc T8.
- **Business behavior trước thay đổi (đã đọc trong code):** mọi ghi đi thẳng bảng bằng anon/authenticated JWT + RLS, `user_id = auth.uid()` do client set, approve/version do client tự gán:
  - `src/hooks/income-expenses/mutations.ts` — `useCreateIncomeExpense`/`useUpdateIncomeExpense` insert/update thẳng `income_expenses` + `income_expense_items`; `useQuickUpdateIncomeExpense` gọi RPC `update_income_expense_quick`.
  - `src/hooks/useInvoices.ts` — `useCreateInvoice` insert `invoices` với `status='APPROVED'`, `approved_at=now`, `approved_by=user.id` **client-side** + insert `excess_amounts` (áp credit, amount âm) + `invoice_items`; `useUpdateInvoice` check `canEditInvoice()` client rồi update + delete/re-insert items; `useApproveInvoice`/`useUnapproveInvoice`/`useBulkApproveInvoices`/`useDeleteInvoice`/`useBulkDeleteInvoices`/`useCancelInvoice`/`useRestoreInvoice`/`useCheckOverdueInvoices` update thẳng `status`; `useForceCancelInvoice` gọi RPC `super_admin_force_cancel_invoice`; legacy `useRecordMeterReading`/`useBulkCreateMeterReadings` insert `meter_readings`.
  - `src/hooks/useDeletePayment.ts` — **hard-delete** `payments` (`.delete()`), hard-delete `excess_amounts` theo `source_payment_id`, soft-delete `income_expenses` theo `payment_id`; dựa `count===0` để suy "không có quyền".
  - `src/hooks/useContracts.ts` — `useCreateContract` insert `contracts` (`status='ACTIVE'`) + `contract_customers` + `contract_services` + update `rooms.status='OCCUPIED'` + `createFirstInvoiceForContract()` insert `invoices` (`APPROVED`, approved_by client) + `invoice_items`; guard cọc/đơn-HĐ là client-side; legacy `useApproveTermination` viết `contract_terminations` + `contracts` + `cash_book`; không có hold cọc.
  - `src/hooks/useManagerSalary.ts` — `useSalaryPayout` insert `income_expenses` (EXPENSE lương) + `income_expense_items`, rồi insert `payments` (method `CT`) + `income_expenses` (INCOME, `approval_status='APPROVED'`) + items để gạch nợ tiền phòng, rồi update `salary_monthly.paid`; `useLockSalaryMonth` bulk-update `income_expenses.approval_status='APPROVED', approved_by=user.id` (tự duyệt phiếu hoa hồng) + upsert `salary_monthly` LOCKED + snapshot; `useSaveSalaryAdjustment`/`ensureMonthly` insert `salary_monthly`/`salary_adjustments`.
  - `src/hooks/useMeterReadings.ts` — insert/update/soft-delete `meter_readings` (`status='APPROVED'`, `approved_by=user.id` client) + RPC `approve_meter_reading`/`bulk_approve_meter_readings`/`bulk_create_meter_readings`.
  - `src/components/invoices/GenerateInvoiceDialog.tsx` — insert `meter_readings` thẳng (`status='APPROVED'`, approved client) rồi gọi `useCreateInvoice`.
- **Business behavior sau thay đổi:** mỗi domain có RPC canonical duy nhất; permission chính xác + org/scope server-derived; invoice `APPROVED`/`DRAFT` do server quyết theo `auto_approve_invoice`; edit approved-unpaid qua locked revision; reversal thay hard-delete; salary payout + commission self-approve đi qua maker-checker/force-approval của T3 với held cashbook; hold cọc 24h server-time. UI cũ vẫn hoạt động dưới flag OFF cho tới canary từng domain.
- **Ảnh hưởng nghiệp vụ/người dùng:** người không đủ quyền bị backend deny dù UI cho thao tác; approve/version/owner không còn client-spoof; xoá phiếu thu chuyển thành "Hủy giao dịch thu tiền (tạo bút toán hoàn tác)" giữ bản gốc; phiếu chi lương/hoa hồng phải qua checker (trừ ngoại lệ sub-limit trên sổ maker giữ); cọc giữ chỗ 24h không bị double-book. Under flag OFF: **không thay đổi trải nghiệm hiện tại**.

---

## 2. Immutable release identity

Chưa có — T5 ở `IN_DESIGN`. Mỗi **domain-slice** (invoice / reversal / thu-chi / meter / contract-deposit / salary) apply riêng và phải điền đủ trước khi owner duyệt:

- Full commit SHA: _chưa có_
- Exact migration path/signature (một file / một RPC signature, không glob, không `db push`): _chưa có_
- Migration SHA-256: _chưa có_
- Generated-types SHA-256 (`src/integrations/supabase/types.ts` sau regen): _chưa có_
- Deployed frontend SHA (Vercel): _chưa có_
- Recovery certification ID (`VERIFIED`): _chưa có — T0a `BLOCKED`_
- Maintenance-window ID: _chưa có_
- Operator / Reviewer / Owner approval reference: _chưa có_

Không dùng branch name (`security/authz-preparation`), "latest", glob migration, hay broad `db push` làm release identity.

---

## 3. Live precheck (chạy read-only ngay trước mỗi slice; chưa thực hiện)

- UTC/local start time.
- Exact live signatures/owners/search_path/grants của mọi RPC đụng tới: `record_invoice_payment_v3`, `super_admin_force_cancel_invoice`, `update_income_expense_quick`, `approve_meter_reading`, `bulk_approve_meter_readings`, `bulk_create_meter_readings`, `get_invoice_statistics_v2` + RPC canonical mới. Lấy từ live catalog, không dùng tên trần.
- **Active callers/writers per domain** — machine-readable writer map (từ code + PostgREST/DB logs), gắn commit SHA. Baseline từ code đã đọc:
  - invoices: `useCreateInvoice`, `useUpdateInvoice`, `useApproveInvoice`, `useUnapproveInvoice`, `useBulkApproveInvoices`, `useDeleteInvoice`, `useBulkDeleteInvoices`, `useCancelInvoice`, `useRestoreInvoice`, `useCheckOverdueInvoices`, `createFirstInvoiceForContract`, `GenerateInvoiceDialog` (gián tiếp), `useSalaryPayout` (đọc invoices để gạch nợ).
  - invoice_items: `useCreateInvoice`, `useUpdateInvoice`, `createFirstInvoiceForContract`.
  - excess_amounts: `useCreateInvoice` (áp credit), `useDeletePayment` (hard-delete).
  - payments: `record_invoice_payment_v3` (T1b), `useDeletePayment` (hard-delete), `useSalaryPayout` (insert method `CT`).
  - income_expenses / income_expense_items: `useCreateIncomeExpense`, `useUpdateIncomeExpense`, `useQuickUpdateIncomeExpense`(RPC), `useDeletePayment`(soft-delete), `useSalaryPayout`, `useLockSalaryMonth`.
  - meter_readings: `useCreateMeterReading`, `useBulkCreateMeterReadings`(x2 — cả `useMeterReadings.ts` và `useInvoices.ts`), `useImportMeterReadings`(RPC), `useUpdateMeterReading`, `useDeleteMeterReading`, `useBulkDeleteMeterReadings`, `GenerateInvoiceDialog`.
  - contracts / contract_customers / contract_services / rooms: `useCreateContract`, `useUpdateContract`, `useSyncContractCustomers`, `useSyncContractServices`, `useDeleteContract`, legacy `useApproveTermination`/`useBulkCreateContracts`.
  - salary_monthly / salary_adjustments / salary_work_ledger_snapshot: `ensureMonthly`, `useSaveSalaryAdjustment`, `useDeleteSalaryAdjustment`, `useLockSalaryMonth`, `useUnlockSalaryMonth`, `useSalaryPayout`.
  - cash_book: legacy `useApproveTermination`.
- Migration-ledger state (Supabase migrations applied vs repo).
- Pre-state table/object/count/hash cho từng bảng đụng tới.
- Financial reconciliation baseline: `node scripts/reconcile-money.mjs [YYYY-MM]` (SUM SQL thật vs tổng-1000-dòng-đầu) cho INCOME/EXPENSE, invoice/payment/credit, deposit, salary, cash_book.
- Browser/runtime baseline (console/network sạch trên flow hiện hữu).
- Monitoring healthy; managed backup reference đã ghi nhận.

---

## 4. Change contract (đích — chưa apply)

### 4.0 Nguyên tắc chung mọi domain-slice

- **Server-derived org/actor/resource:** RPC lấy `auth.uid()` cho actor; organization + resource (building/room/contract/invoice/account/cashbook) resolve từ DB, **không tin `user_id`/`approved_by`/`organization_id` do client gửi**.
- **Exact permission + scope:** kiểm exact permission theo domain (không dùng permission rộng như `invoices.edit` cho hành động khác), assert active membership + resource scope trước mọi effect.
- **State/version/CAS:** đọc + lock subject, so `expected_version`, assert affected-rows = 1; không read-modify-write không khoá.
- **Lock order công bố** để tránh deadlock (vd invoice → payments → excess_amounts → income_expenses; hoặc contract → room → invoice).
- **Idempotency:** durable operation unique theo org + operation + subject + caller + idempotency key + canonical payload hash; same payload → replay response gốc; different payload → conflict xác định. (Tái dùng khung T1b.)
- **Atomic:** mọi effect của một hành động commit/rollback cùng nhau.
- **Audit/provenance:** append-only (actor, org, subject, key, payload hash, before/after, timestamp).
- **Forward-fix/reversal:** không rollback bằng xoá row tiền; freeze + forward-fix + compensating reversal.
- **Feature flag mặc định OFF** cho mọi slice; grant `EXECUTE` cho RPC canonical review riêng, không grant kèm migration schema.

### 4.1 Invoice domain

- `create_invoice_v1(...)`: server đọc setting tổ chức **`auto_approve_invoice`** → bật thì `status='APPROVED'` + set `approved_at/approved_by = actor server-side`; tắt thì `status='DRAFT'` cần duyệt (quyết định 27.2.1). Validate `contract_id`/`building_id`/`room_id` cùng org + partial-unique 1 invoice/HĐ/kỳ (`kind='MONTHLY'`, `deleted_at IS NULL`, `status<>CANCELLED`). `excess_amounts` áp credit + `invoice_items` ghi cùng transaction. Thay `useCreateInvoice` + `createFirstInvoiceForContract`.
- `edit_approved_invoice_v1(...)`: chỉ cho invoice `APPROVED` **chưa từng có payment**, permission riêng, `expected_version` + `reason` + revision before/after + audit + hàng hậu kiểm cho kế toán/owner (27.2.2). Invoice đã có payment KHÔNG đi đường này. Thay nhánh approved của `useUpdateInvoice` (nhánh DRAFT giữ đường thường dưới flag).
- Lifecycle (`approve`/`unapprove`/`cancel`/`restore`/`overdue`/`force_cancel`): CAS theo state hiện tại; `approved_by` server-set; `super_admin_force_cancel_invoice` re-audit exact ACL/search_path (đang tồn tại).

### 4.2 Payment reversal domain (thay `useDeletePayment`)

- `reverse_invoice_payment_v3(...)`: **KHÔNG hard-delete** `payments`/`excess_amounts` (27.2.3). Tạo operation/bút toán đối ứng liên kết bản gốc (`payments` reversal + `income_expenses` đối ứng), recompute invoice `paid_amount/status/paid_date`, huỷ credit `excess_amounts` bằng dòng đối ứng, giữ cả gốc + reversal để truy vết; UI nhãn **"Hủy giao dịch thu tiền (tạo bút toán hoàn tác)"**.
- Anti-double-reversal: unique guard theo `source_payment_id` — một payment chỉ reverse một lần; retry replay operation gốc.
- Giữ guard `[HANDOVER_LOCKED]` (phiên bàn giao tiền mặt) tương đương logic hiện tại nhưng enforce server-side.
- Exact permission `thu_tien.reverse` (tên chuẩn hoá ở T2), scope theo org của invoice.

### 4.3 Thu-chi (income/expense) domain (thay `income-expenses/mutations.ts`)

- `create_income_expense_v1` / `update_income_expense_v1`: server set `user_id`/`creator_name`; validate `building_id`/`room_id`/`tenant_id`/`contract_id`/`account_id` cùng org; update chỉ khi UNAPPROVED (CAS). Giữ `update_income_expense_quick` nhưng re-audit exact permission/scope.
- **Maker-checker + self-limit (27.2.4/27.2.5):** phiếu chi thông thường dưới hạn mức → maker tự duyệt **chỉ trên sổ quỹ maker đang giữ**, exact permission + bắt buộc hậu kiểm; force-approval (hoa hồng, thưởng, refund/cọc, lương, lợi nhuận, HĐ/thanh lý) luôn chờ người khác, **không xét hạn mức**. Maker chỉ chọn cashbook mình giữ; không sổ phù hợp → phiếu chờ duyệt để trống cashbook; tại final decision accountant/owner chọn cashbook được post + bổ sung ảnh chứng từ, hệ thống snapshot/version/audit trước khi ghi tiền. Engine ở T3; T5 route canonical writer vào engine đó.

### 4.4 Meter reading domain (thay `useMeterReadings.ts` + insert trong `GenerateInvoiceDialog`)

- `create_meter_reading_v1` / `bulk_create_meter_readings` (re-audit) / `update`/`delete`: server set `user_id`/`recorded_by`; `approved_by`/`approved_at` chỉ do path duyệt server-side (không client `status='APPROVED'`); validate `meter_id`/`room_id` cùng org + no-duplicate theo `settlement_month`. `GenerateInvoiceDialog` gọi RPC thay vì insert trực tiếp. Re-audit `approve_meter_reading`/`bulk_approve_meter_readings`.

### 4.5 Contract + deposit domain (thay `useCreateContract`)

- `create_contract_v1(...)`: atomic contract + contract_customers + contract_services + room status + first invoice (gọi `create_invoice_v1`, chịu `auto_approve_invoice`); server-enforce guard "1 HĐ ACTIVE/phòng", "≥1 khách đại diện", "đủ cọc hoặc acknowledged".
- **Hold cọc 24h (27.2.6):** cọc `PENDING_APPROVAL` giữ chỗ độc quyền 24 giờ **theo server-time**, cột `expires_at`, **no double-hold** (unique/exclusion trên room khi đang hold); approve/post → reservation; reject/cancel/expiry → giải phóng; approve sau expiry re-check phòng. Cần schema mới (bảng/cột hold) — **chưa tồn tại trong code** (xem open_questions).

### 4.6 Salary/profit payout domain (thay `useSalaryPayout` + `useLockSalaryMonth`)

- `salary_payout_v1(...)`: phiếu chi lương là **force-approval class** (27.2.4) → luôn qua checker, không self-approve; atomic {income_expenses EXPENSE + items; nếu gạch nợ tiền phòng: payment method `CT` + income_expenses INCOME + items; update salary_monthly.paid}. Payment gạch nợ **phải đi qua `record_invoice_payment_v3`** (T1b) thay vì insert `payments` trực tiếp — loại double-writer.
- `lock_salary_month_v1`: việc tự duyệt phiếu hoa hồng (`income_expenses.approval_status='APPROVED', approved_by=user.id`) hiện là self-approve force-approval class → phải route qua checker/engine T3; `approved_by` server-set.

---

## 5. Test evidence trước production (chưa chạy — kế hoạch)

Mỗi domain-slice phải đạt toàn bộ trước khi rời `IN_DESIGN`:

- Project restore/staging ID (từ T0a recovery `VERIFIED`).
- Unit/property tests (Vitest + fast-check): rounding tiền (`roundInvoiceTotal`), phân bổ cọc, recompute invoice sau reversal, per-invoice atomic bulk.
- Direct JWT REST/RPC matrix (T4a): JWT đủ permission → allow trong scope; JWT sai permission / chỉ có permission rộng cũ → deny; suspended/revoked/cross-org → deny.
- Cross-org/foreign-resource: account/room/contract/invoice/cashbook/meter khác org → deny trước effect.
- Concurrent/retry/rollback-injection: same idempotency key + same payload → một effect; khác payload → conflict; double-reverse deny; hold cọc đồng thời → no double-hold; inject fail từng bước → rollback toàn operation.
- `npm run typecheck:baseline` (không tăng lỗi) + `npx tsc --noEmit -p tsconfig.app.json`.
- Related + full Vitest; `npm run lint`; `npm run build`.
- `node scripts/check-definer-acl.mjs`.
- `node scripts/check-view-invoker.mjs` (nếu đụng VIEW — GOTCHA `CREATE OR REPLACE VIEW` rớt `security_invoker=true`).
- Generated Supabase type drift = 0 sau `npm run gen:types`.
- Full money reconciliation `node scripts/reconcile-money.mjs`: delta ngoài transactions test = 0 cho INCOME/EXPENSE, invoice/payment/credit, deposit, salary, cash_book, bút toán đối ứng.
- Browser happy/edge/deny (Playwright MCP trên staging/restore, không production) + console/network sạch.
- Reviewer verdict ghi rõ.

---

## 6. Canary và production gate

- **Canary organization/users:** _chưa chốt_.
- **Transaction count cap:** default `0`.
- **VND cap:** default `0` (0 = không flip).
- **Observation interval / expansion approval:** _chưa chốt_.
- **Old writer drain proof:** T5 chỉ bật canonical dưới flag; drain + revoke direct DML thuộc T6b/T7. T5 phải chứng minh mọi writer cũ trong writer map (§3) hoặc được thay hoặc còn chạy song song có kiểm soát (vd `income_expenses` shared: cho canonical/direct `DRAFT` có guard, chặn direct `APPROVED/POSTED` — plan 27.4 cuối).
- **Exact revoke/policy/signature:** ngoài scope T5.

Default nếu owner chưa chốt: canary = `0`, VND cap = `0`, mọi flag = `OFF`, không apply/flip.

---

## 7. Mandatory abort

Abort ngay khi có một trong:

- unauthorized hoặc cross-org success;
- financial drift khác 0 (reconcile-money);
- duplicate payment/posting/reversal (đặc biệt double-reverse của reversal domain hoặc double-writer salary payment `CT`);
- orphan/split operation (vd invoice tạo nhưng items fail; phiếu cọc mồ côi; hold không expiry);
- unexpected legacy writer ghi thẳng bảng đã canonical hoá;
- backup/object hash mismatch;
- canary happy path bị deny không giải thích;
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút;
- p95 > 2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry;
- **double-hold cọc** hoặc hold không giải phóng khi reject/cancel/expiry.

Khi abort: disable canary/flag, freeze domain, giữ evidence; **không xoá/sửa row tiền để rollback** — reconcile, forward-fix, tạo compensating reversal (đúng tinh thần 27.2.3).

---

## 8. Post-apply evidence (điền khi/ nếu apply — hiện trống)

- Apply start/end UTC.
- Catalog/signature/grant pre/post diff (RPC canonical + grant).
- Direct API deny/allow result (two-org JWT).
- Browser result (flow của domain vừa flip).
- Reconciliation delta (mọi domain tiền = 0 ngoài canary).
- Runtime error/latency/deny metrics.
- Hidden caller/legacy writer result (writer map §3 = 0 unexpected).
- Observation completed at; Final reviewer; Final state (`APPLIED`/`VERIFIED`).
- Tracker update commit (cập nhật [AUTHORIZATION-IMPLEMENTATION-STATUS.md](./../AUTHORIZATION-IMPLEMENTATION-STATUS.md)).

Evidence không chứa credential, JWT, signed URL, private object path hay PII.

---

### Ghi chú đóng

T5 gom nhiều domain; theo 27.4 phải cutover **từng domain một qua cùng gate**, không một lần đổi tất cả. Không "vá thêm flag rồi gọi là xong": mỗi domain-slice cần RPC canonical explicit org boundary + state machine + idempotency + audit + reconciliation, dependency T1b/T2/T3/T4a/T6a `VERIFIED`, và lệnh owner riêng cho đúng slice. Trạng thái hiện tại: **NO-GO cho production**.