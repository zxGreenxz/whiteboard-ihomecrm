# Authorization tranche `T5` — Canonical writers per domain (flags default OFF)

> Trạng thái: `BLOCKED` overall. T5-infra và backend meter-reading five-RPC partial slice đã `APPLIED`; frontend meter wiring mới `PREPARED` trên branch; full meter domain và các domain còn lại vẫn `BLOCKED/IN_DESIGN`.
> Production mutation / canary / flag flip **mới**: **BLOCKED** — không được apply khi thiếu bất kỳ trường bắt buộc ở §2, khi recovery chưa `VERIFIED`, hoặc khi owner chưa ra lệnh riêng cho đúng domain-slice (SHA + migration SHA-256 + maintenance window + canary count + VND cap). Default khi chưa chốt: canary = `0`, VND cap = `0`, mọi flag = `OFF`, không apply/flip. Backend meter partial slice đã áp là ngoại lệ hiện hữu được ghi rõ tại §4.4; nó không chứng minh full-domain cutover, frontend production deployment hoặc feature-flag enforcement.

Nguồn chuẩn nghiệp vụ: [AUTHORIZATION-PLAN.md](../AUTHORIZATION-PLAN.md) mục 27 (đặc biệt 27.2 quyết định owner, 27.4 cutover theo domain). Tracker runtime: [AUTHORIZATION-IMPLEMENTATION-STATUS.md](./../AUTHORIZATION-IMPLEMENTATION-STATUS.md) (T5 = `BLOCKED`). Tài liệu này KHÔNG phải migration được duyệt. Source SQL domain-writer có thể tồn tại như artifact `BLOCKED/IN_DESIGN` để review, nhưng không vì nằm dưới `supabase/migrations/` mà được phép apply; production chỉ nhận exact replacement artifact sau khi dependency và evidence bên dưới đạt gate.

---

## 1. Scope và dependency

- **Deliverable/tranche ID:** T5 — Canonical writers theo domain, callable grant review riêng, flag mặc định OFF (plan 27.3/27.5 dòng T5).
- **Domain:** invoice (create/edit/approve/lifecycle), payment reversal (thu tiền hoàn tác), income/expense voucher (thu-chi), meter reading, deposit/contract create + first-invoice, salary/profit payout. Payment *collect* (single + bulk) KHÔNG thuộc T5 — đã tách sang T1b (`record_invoice_payment_v3`).
- **Normative plan section:** mục 27.2 (quyết định 1–8), 27.4 (8 bước cutover theo domain), 27.6 (cửa GO tối thiểu).
- **Dependencies và trạng thái:**
  - Recovery local — `ACCEPTED_LOCAL` theo owner gate 2026-07-16; strict `VERIFIED` chưa đạt. Trạng thái này cho phép tiếp tục preparation theo lệnh owner nhưng không tự mở writer/canary/cutover tiền.
  - T1a containment prototype submit/decide — `APPLIED`, còn observation trước `VERIFIED`; không được re-grant prototype.
  - T1b `record_invoice_payment_v3` hardening — `BLOCKED`. T5 reversal/payout tái dùng contract collect của T1b nên phụ thuộc trực tiếp.
  - T2 RBAC source-of-truth + authorization-version — `BLOCKED` (permission `hoa_don.*`, `thu_chi.*`, `luong.*`, `cong_to.*`, `hop_dong.*` chưa chuẩn hoá).
  - T3 approval contract v2 (maker-checker, self-limit, held cashbook, reversal) — `BLOCKED`. Mọi phiếu chi force-approval + self-approve sub-limit của T5 phải chạy qua engine T3.
  - T4a harness (two-org JWT, concurrency, full-domain reconciliation, writer map) — `IN_DESIGN`. T5 không có evidence hợp lệ nếu thiếu harness này.
  - `ORG_READY(domain)` từ T6a-preflight (read-only) — chỉ cần subject + closure foreign-resource của **domain-slice đang xây** có derivation org xác định; **không** hard-depend full T6a (backfill/constraint/RLS-shadow toàn hệ thuộc T6, đứng SAU T5 theo §27.3). Full T6 của domain là gate trước canary (T6b/T7), không phải gate trước khi viết writer OFF.
- **T5-infra (sub-slice đầu tiên, trước mọi domain writer):** T5 sở hữu **schema feature-flag/canary server-enforced** trong private schema (`app_private.server_feature_flags` + canary orgs + operations-cap ledger + append-only events): mode `OFF|SHADOW|CANARY|ON`, `force_freeze`, `config_version` (CAS), window `starts_at/ends_at`, `max_operation_count`, `max_single_amount_vnd`/`max_total_amount_vnd` (default 0), release identity (SHA/migration hash/window/approval ref), org allowlist (canary theo organization, không theo user), stable operation key chống retry-ăn-cap-hai-lần. Evaluator server-side trả `LEGACY|SHADOW|CANONICAL|FROZEN`; missing/malformed row = không bật new path; cả canonical endpoint LẪN legacy guard cùng consume evaluator. T6b/T7 chỉ *vận hành* flip/canary/drain trên infrastructure này — không tự tạo schema. Client không có DML; flag không thay authorization (writer vẫn kiểm exact permission/state/version/org độc lập với mode).
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
  - `src/hooks/useMeterReadings.ts` — trạng thái partial routing (2026-07-16): create/bulk-create/update/delete/bulk-delete đã gọi 5 RPC v1 (`4511a72`, trên branch); import vẫn gọi RPC legacy `bulk_create_meter_readings`; approve/bulk-approve vẫn RPC legacy; unapprove vẫn direct-UPDATE `meter_readings`.
  - `src/components/invoices/GenerateInvoiceDialog.tsx` — vẫn insert `meter_readings` thẳng (`status='APPROVED'`, approved client) rồi gọi `useCreateInvoice`; `src/hooks/invoices/useExcelInvoiceData.ts` (`useSubmitExcelInvoices`) cũng direct-INSERT `meter_readings` APPROVED.
- **Business behavior sau thay đổi:** mỗi domain có RPC canonical duy nhất; permission chính xác + org/scope server-derived; invoice `APPROVED`/`DRAFT` do server quyết theo `auto_approve_invoice`; edit approved-unpaid qua locked revision; reversal thay hard-delete; salary payout + commission self-approve đi qua maker-checker/force-approval của T3 với held cashbook; hold cọc 24h server-time. UI cũ vẫn hoạt động dưới flag OFF cho tới canary từng domain.
- **Ảnh hưởng nghiệp vụ/người dùng:** người không đủ quyền bị backend deny dù UI cho thao tác; approve/version/owner không còn client-spoof; xoá phiếu thu chuyển thành "Hủy giao dịch thu tiền (tạo bút toán hoàn tác)" giữ bản gốc; phiếu chi lương/hoa hồng phải qua checker (trừ ngoại lệ sub-limit trên sổ maker giữ); cọc giữ chỗ 24h không bị double-book. Under flag OFF: **không thay đổi trải nghiệm hiện tại**.

---

## 2. Immutable release identity

Chưa hoàn chỉnh theo từng slice. Meter backend partial slice có migration path `20260716160000` + hotfix `20260716170000`; frontend branch wiring có commit `4511a72` — nhưng spec này chưa ghi đủ full commit SHA, migration SHA-256, deployed frontend SHA, maintenance window và approval/evidence reference để đạt `VERIFIED`. Income/expense current artifact chưa có accepted release identity (BB0C chỉ là identity của revision đã bị supersede). Mỗi **domain-slice** (invoice / reversal / thu-chi / meter / contract-deposit / salary) apply riêng và phải điền đủ trước khi owner duyệt:

- Full commit SHA: _chưa có_
- Exact migration path/signature (một file / một RPC signature, không glob, không `db push`): _chưa có_
- Migration SHA-256: _chưa có_
- Generated-types SHA-256 (`src/integrations/supabase/types.ts` sau regen): _chưa có_
- Deployed frontend SHA (Vercel): _chưa có_
- Recovery reference: `20260715T152622Z-online-unfrozen` + `20260716T045126Z-db-portable`, owner state `ACCEPTED_LOCAL`; strict `VERIFIED`: _chưa có_
- Maintenance-window ID: _chưa có_
- Operator / Reviewer / Owner approval reference: _chưa có_

Không dùng branch name (`security/authz-preparation`), "latest", glob migration, hay broad `db push` làm release identity.

---

## 3. Live precheck theo từng slice (chạy read-only ngay trước mỗi slice)

Meter partial slice có một phần catalog/JWT evidence theo tracker, nhưng chưa có full writer-map, feature-route, frontend-production, drain và canary evidence — không được coi là đã hoàn tất toàn bộ precheck §3. Template dưới vẫn bắt buộc cho mọi slice mới.

- UTC/local start time.
- Exact live signatures/owners/search_path/grants của mọi RPC đụng tới: `record_invoice_payment_v3`, `super_admin_force_cancel_invoice`, `update_income_expense_quick`, `approve_meter_reading`, `bulk_approve_meter_readings`, `bulk_create_meter_readings`, `get_invoice_statistics_v2` + RPC canonical mới. Lấy từ live catalog, không dùng tên trần.
- **Active callers/writers per domain** — machine-readable writer map (từ code + PostgREST/DB logs), gắn commit SHA. Baseline từ code đã đọc:
  - invoices: `useCreateInvoice`, `useUpdateInvoice`, `useApproveInvoice`, `useUnapproveInvoice`, `useBulkApproveInvoices`, `useDeleteInvoice`, `useBulkDeleteInvoices`, `useCancelInvoice`, `useRestoreInvoice`, `useCheckOverdueInvoices`, `createFirstInvoiceForContract`, `GenerateInvoiceDialog` (gián tiếp), `useSalaryPayout` (đọc invoices để gạch nợ).
  - invoice_items: `useCreateInvoice`, `useUpdateInvoice`, `createFirstInvoiceForContract`.
  - excess_amounts: `useCreateInvoice` (áp credit), `useDeletePayment` (hard-delete).
  - payments: `record_invoice_payment_v3` (T1b), `useDeletePayment` (hard-delete), `useSalaryPayout` (insert method `CT`).
  - income_expenses / income_expense_items: `useCreateIncomeExpense`, `useUpdateIncomeExpense`, `useQuickUpdateIncomeExpense`(RPC), `useDeletePayment`(soft-delete), `useSalaryPayout`, `useLockSalaryMonth`.
  - meter_readings: `useCreateMeterReading`, `useBulkCreateMeterReadings`(x2 — cả `useMeterReadings.ts` và `useInvoices.ts`), `useImportMeterReadings`(RPC legacy), `useUpdateMeterReading`, `useDeleteMeterReading`, `useBulkDeleteMeterReadings`, `useUnapproveMeterReading`(direct-UPDATE), `GenerateInvoiceDialog`(direct-INSERT), `useSubmitExcelInvoices` trong `useExcelInvoiceData.ts`(direct-INSERT). Phân biệt hook chỉ còn định nghĩa với caller đang hoạt động trước khi chốt writer map.
  - contracts / contract_customers / contract_services / rooms: `useCreateContract`, `useUpdateContract`, `useSyncContractCustomers`, `useSyncContractServices`, `useDeleteContract`, legacy `useApproveTermination`/`useBulkCreateContracts`.
  - salary_monthly / salary_adjustments / salary_work_ledger_snapshot: `ensureMonthly`, `useSaveSalaryAdjustment`, `useDeleteSalaryAdjustment`, `useLockSalaryMonth`, `useUnlockSalaryMonth`, `useSalaryPayout`.
  - cash_book: legacy `useApproveTermination`.
- Migration-ledger state (Supabase migrations applied vs repo).
- Pre-state table/object/count/hash cho từng bảng đụng tới.
- Financial reconciliation baseline: `node scripts/reconcile-money.mjs [YYYY-MM]` (SUM SQL thật vs tổng-1000-dòng-đầu) cho INCOME/EXPENSE, invoice/payment/credit, deposit, salary, cash_book.
- Browser/runtime baseline (console/network sạch trên flow hiện hữu).
- Monitoring healthy; managed backup reference đã ghi nhận.

---

## 4. Change contract (đích — T5-infra và meter five-RPC subset đã apply; phần còn lại chưa apply)

### 4.0 Nguyên tắc chung mọi domain-slice

- **Server-derived org/actor/resource:** RPC lấy `auth.uid()` cho actor; organization + resource (building/room/contract/invoice/account/cashbook) resolve từ DB, **không tin `user_id`/`approved_by`/`organization_id` do client gửi**.
- **Exact permission + scope:** kiểm exact permission theo domain (không dùng permission rộng như `invoices.edit` cho hành động khác), assert active membership + resource scope trước mọi effect.
- **State/version/CAS:** đọc + lock subject, so `expected_version`, assert affected-rows = 1; không read-modify-write không khoá.
- **Lock order công bố** để tránh deadlock (vd invoice → payments → excess_amounts → income_expenses; hoặc contract → room → invoice).
- **Idempotency:** durable operation unique theo org + operation + subject + caller + idempotency key + canonical payload hash; same payload → replay response gốc; different payload → conflict xác định. (Tái dùng khung T1b.)
- **Atomic:** mọi effect của một hành động commit/rollback cùng nhau.
- **Audit/provenance:** append-only (actor, org, subject, key, payload hash, before/after, timestamp).
- **Forward-fix/reversal:** không rollback bằng xoá row tiền; freeze + forward-fix + compensating reversal.
- **Feature flag mặc định OFF** cho mọi slice mới; grant `EXECUTE` cho RPC canonical review riêng, không grant kèm migration schema. **Ngoại lệ hiện hữu / technical debt:** meter five-RPC partial slice (`20260716160000`) grant thẳng cho `authenticated` trong migration và KHÔNG gọi `evaluate_feature_route` — không được mô tả là flag-gated hoặc canary-ready cho tới khi có forward fix + direct tests.

### 4.1 Invoice domain

- `create_invoice_v1(...)`: server đọc setting tổ chức **`auto_approve_invoice`** → bật thì `status='APPROVED'` + set `approved_at/approved_by = actor server-side`; tắt thì `status='DRAFT'` cần duyệt (quyết định 27.2.1). Validate `contract_id`/`building_id`/`room_id` cùng org + partial-unique 1 invoice/HĐ/kỳ (`kind='MONTHLY'`, `deleted_at IS NULL`, `status<>CANCELLED`). `excess_amounts` áp credit + `invoice_items` ghi cùng transaction. Thay `useCreateInvoice` + `createFirstInvoiceForContract`.
- **Storage + missing-row semantics của `auto_approve_invoice`:** bảng typed riêng `organization_invoice_settings(organization_id PK → organizations, auto_approve_invoice boolean NOT NULL DEFAULT true, version bigint, updated_by, updated_at)` — migration T5 invoice-slice backfill mọi org hiện hữu = `true`; org bootstrap (T2 lifecycle) tạo row `true`. **Row thiếu/malformed = abort tạo invoice + alert cấu hình** — KHÔNG âm thầm coi là ON hay OFF. Update setting qua RPC exact-permission + CAS + reason + audit; không client DML. KHÔNG reuse `invoice_generation_settings.auto_approve` (bảng per-user, default `false`, policy own-settings — sai semantics org-wide; giữ nguyên cho scheduler cho tới khi inventory caller xong). Đây là **business setting**, không phải rollout flag của T5-infra — hai hệ tách biệt.
- **Legacy writer bypass phải drain:** `generate_invoices_for_building_v2` (SECURITY DEFINER, delegate sang writer cũ hard-code `status='APPROVED'` — `20260528000002:95-120` → `20260510000003:66-76`; hotfix `20260710130000:100-105` chỉ revoke signature v1, KHÔNG revoke wrapper v2). Khi org tắt auto-approve, đường này vẫn tạo invoice APPROVED → **phải nằm trong inventory drain/revoke của invoice-slice trước canary**, nếu không invariant "mọi create path chịu `auto_approve_invoice`" không chứng minh được.
- `edit_approved_invoice_v1(...)`: chỉ cho invoice `APPROVED` **chưa từng có payment**, permission riêng, `expected_version` + `reason` + revision before/after + audit + hàng hậu kiểm cho kế toán/owner (27.2.2). Invoice đã có payment KHÔNG đi đường này. Thay nhánh approved của `useUpdateInvoice` (nhánh DRAFT giữ đường thường dưới flag).
- Lifecycle (`approve`/`unapprove`/`cancel`/`restore`/`overdue`/`force_cancel`): CAS theo state hiện tại; `approved_by` server-set; `super_admin_force_cancel_invoice` re-audit exact ACL/search_path (đang tồn tại).

### 4.2 Payment reversal domain (thay `useDeletePayment`)

- `reverse_invoice_payment_v3(...)`: **KHÔNG hard-delete** `payments`/`excess_amounts` (27.2.3). Tạo operation/bút toán đối ứng liên kết bản gốc (`payments` reversal + `income_expenses` đối ứng), recompute invoice `paid_amount/status/paid_date`, huỷ credit `excess_amounts` bằng dòng đối ứng, giữ cả gốc + reversal để truy vết; UI nhãn **"Hủy giao dịch thu tiền (tạo bút toán hoàn tác)"**.
- Anti-double-reversal: unique guard theo `source_payment_id` — một payment chỉ reverse một lần; retry replay operation gốc.
- Giữ guard `[HANDOVER_LOCKED]` (phiên bàn giao tiền mặt) tương đương logic hiện tại nhưng enforce server-side.
- Exact permission **`thu_tien.undo`** — dùng đúng key ĐÃ SEED ở `20260713110100_sprint2b_seed_permission_definitions.sql:94` và khớp plan §13 (`AUTHORIZATION-PLAN.md:1271`). KHÔNG giới thiệu key mới `thu_tien.reverse` (tránh hai key đồng nghĩa không có migration mapping role); scope theo org của invoice.

### 4.3 Thu-chi (income/expense) domain (thay `income-expenses/mutations.ts`)

- `create_income_expense_v1` / `update_income_expense_v1`: server set `user_id`/`creator_name`; validate `building_id`/`room_id`/`tenant_id`/`contract_id`/`account_id` cùng org; update chỉ khi UNAPPROVED (CAS). Giữ `update_income_expense_quick` nhưng re-audit exact permission/scope.
- **Maker-checker + self-limit (27.2.4/27.2.5):** phiếu chi thông thường dưới hạn mức → maker tự duyệt **chỉ trên sổ quỹ maker đang giữ**, exact permission + bắt buộc hậu kiểm; force-approval (hoa hồng, thưởng, refund/cọc, lương, lợi nhuận, HĐ/thanh lý) luôn chờ người khác, **không xét hạn mức**. Maker chỉ chọn cashbook mình giữ; không sổ phù hợp → phiếu chờ duyệt để trống cashbook; tại final decision accountant/owner chọn cashbook được post + bổ sung ảnh chứng từ, hệ thống snapshot/version/audit trước khi ghi tiền. Engine ở T3; T5 route canonical writer vào engine đó.

#### 4.3.1 Artifact create draft hiện tại: `BLOCKED`, không phải `PREPARED`

`supabase/migrations/20260716180000_t5_income_expense_create_draft_writer.sql` là source review-only: **không apply, không grant, không route frontend, giữ feature `OFF`**. Bằng chứng concurrency 18/18 từng bind vào SHA-256 `BB0CDE6B…C2691E7` chỉ chứng minh một phần hành vi của revision đó; mọi chỉnh sửa sau revision này làm evidence cũ mất hiệu lực và không chữa các blocker contract.

**T2 phải có trước khi thay bridge tạm trong writer:**

- active tenant `OWNER` được materialize bằng system-role/binding ổn định dù không có `staff_assignments`; OWNER chỉ có tenant capability, không có platform/tenant-khác capability;
- resolver một-statement derive scope từ resource, lock đúng witness graph và áp precedence: emergency deny/suspended org → member DENY → role DENY → member ALLOW → role ALLOW → default deny;
- `member_override_scopes`, membership/binding validity window và `authorization_version` lifecycle đầy đủ;
- scope `CASHBOOK` chỉ giới hạn permission; possession là relation canonical riêng (`CUSTODIAN|OPERATOR`) có lifecycle/version. Permission không possession và possession không permission đều deny; `accounts.user_id`/`account_shared_users` chỉ sinh candidate review, không là authority cuối;
- platform super-admin không bypass tenant membership hoặc permission; emergency/platform operation là path riêng có audit.

**T3/containment phải có trước khi canonical draft có thể callable:**

- canonical draft được đánh dấu atomically ngay lúc tạo bằng marker/state server-owned độc lập với `approval_request_id` và ledger idempotency; revision hiện tại vẫn ghi `approval_request_id=NULL`, `system_source=NULL`, `approval_status='UNAPPROVED'` nên chưa được bảo vệ;
- legacy `approve_voucher`/`unapprove_voucher`/`pay_draft_fee_voucher`/`restore_income_expense`, direct cancel/update và mọi promotion writer đã inventory phải reject row canonical trước effect; creator shortcut `ie.user_id=auth.uid()` không còn là approval authority cho canonical flow;
- containment phải bao phủ cả `update_income_expense_quick(uuid,uuid,jsonb,text)` và direct payload update: RPC quick-edit hiện chỉ kiểm creator/super-admin rồi có thể gắn `account_id` bất kỳ, nên một draft canonical `account_id=NULL` có thể bị nối sang cashbook khác tenant nếu guard chỉ bảo vệ `approval_status`;
- legacy **unmarked** rows chỉ giữ compatibility trong path đã review; containment provenance-scoped, không global-break tùy tiện;
- state phân biệt `DRAFT`, `PENDING_APPROVAL`, `POSTED`, `DENIED`, `REJECTED`, `CANCELLED`, `REVERSED`;
- final decision revalidate cashbook possession + `cashbooks.post`, kỳ khóa, số tiền, evidence, maker-checker và force-approval class;
- pending draft được `account_id = NULL`; cashbook chỉ bắt buộc khi transition sang posting hoặc self-approve hợp lệ. Trong khi chưa có `update_income_expense_v1` canonical, row marked phải đóng băng khỏi mọi legacy/direct payload mutation chứ không chỉ lifecycle transition.

**Writer-local replacement còn phải đóng:**

- bỏ legacy staff/role JSON bridge và mọi `v_is_super OR ...` tenant bypass;
- đóng các nhánh NULL-organization fail-open trong writer hiện tại: `account_shared_users.organization_id IS NULL` đang được chấp nhận như authority dùng cashbook và `contract_tenants.organization_id IS NULL` như proof membership — mâu thuẫn T2 §4.2 ("zero ambiguous legacy cashbook grant được auto-allow") và doctrine fail-closed T6a; claim "mọi foreign resource close về org của building" hiện SAI cho hai witness này;
- idempotency conflict hiện chỉ trong phạm vi MỘT building (PK có `subject_scope=building_id`): same key + different building tạo operation thứ hai và voucher thứ hai, KHÔNG conflict — hoặc mở rộng conflict detection cross-scope hoặc ghi tường minh giới hạn này vào contract;
- force-approval class boundary hiện dựa trên display name tenant-editable (`nrm_vn(t.name) IN ('hoa hong moi gioi','thuong nong sale')`) — rename/duplicate type sẽ lách khỏi classification; phải chuyển sang cột schema-owned (như `is_deposit`) trước khi coi classification là server-owned; lookup type cũng phải kiểm soft-delete/active;
- artifact hiện `CREATE OR REPLACE` evaluator + constraint của shared infra ĐÃ APPLIED (`20260716120200`) bên trong một domain slice — thay đổi rollout semantics cho MỌI domain tương lai không có release identity riêng; phải tách thành migration T5-infra riêng có identity/review độc lập;
- **writer map §3 THIẾU modality cron:** `generate_recurring_vouchers` (pg_cron, `20260603000011` + `20260710120300`) là scheduled server-side writer INSERT `income_expenses` không người giám sát; template pre-existing `repeat_auto_approve=true` chưa được phân tích force-approval; ~35 migration files có `INSERT INTO income_expenses` — baseline frontend-hook-only là chưa đủ; inventory/drain plan phải bao phủ cron + migration DML;
- claim/conflict-wait full idempotency identity trước admission của operation mới; completed replay vẫn recheck current tenant authority nhưng không chạy lại rollout/effect-only hoặc mutable payload/resource validation. Revision hiện tại đã claim-before-admission nhưng vẫn validate building/org/type/room/tenant/contract/account/item types trước claim, nên replay có thể hỏng sau archive/reclassification và vẫn `BLOCKED`; first claimant abort phải cho second claimant trở thành claimant thật;
- lock order thống nhất parent-before-child (`contract → room`, role/binding/scope theo contract T2); final authority/deadline/canary recheck phải sau **mọi** điểm có thể block (kể cả voucher-code trigger/audit lock) và ngay trước complete operation. Row lock không ngăn `valid_to`/`ends_at` tự hết hạn theo thời gian; contract activation phải định nghĩa lease margin hoặc commit-time protocol đủ để không có khoảng chờ không giới hạn sau recheck;
- với generic non-commission path, validate contract trước nhưng insert header `contract_id = NULL`, insert item đã chứng minh non-deposit/non-commission, rồi attach contract atomically để tránh item trigger churn `contracts.updated_at`; không áp ordering này cho commission writer;
- JSON type/date/money validation fail-closed, kiểm raw negative trước rounding, canonical text normalization nhất quán và budget tổng accrual bucket;
- **attachment validation contract (review 2026-07-17):** SQL hiện chỉ kiểm shape/length/cntrl/HTTPS-regex — CHƯA kiểm: (a) ownership — URL phải thuộc bucket `income-expense-attachments` đúng project + folder actor (hoặc member cùng org, chọn một và ghi rõ) + object tồn tại trong `storage.objects` (FOR SHARE) + strict percent-decode canonical; (b) charset RFC-3986 allowlist thay vì `[:cntrl:]`/`[:space:]` locale-sensitive (U+200B/U+202E/U+FEFF/U+00AD hiện lọt); (c) MIME/size enforce ở bucket (`file_size_limit`, `allowed_mime_types`) — hiện chỉ client-side; (d) dedupe + canonical encoding để attachments không phá idempotency hash (hiện là field duy nhất hash theo raw spelling — retry đổi thứ tự/encoding → 23505 giả); (e) TS adapter mirror validation fail-fast trước khi build args;
- rollout config dùng exact release identity + CAS generation/event; cap ledger non-negative, finite và append-only; seed/reapply không được giữ im lặng một row cùng key đang bật;
- audit/provenance append-only và không biến mất do subject hard-delete.

Chỉ replacement source mới, có commit SHA + migration SHA-256 + installed-function fingerprints, fresh disposable rollback/concurrency suite và zero-residue độc lập, mới được xét `PREPARED`. Passing test của revision cũ không được chuyển trạng thái cho revision mới.

**Bổ sung từ vòng review đối kháng 2026-07-17 (40-luồng) — defect writer/rollout xác nhận:**

*Final authority/deadline (trace đầy đủ các điểm block sau final decision):*

- Sau final recheck (dòng ~1122–1163) writer còn các điểm CÓ THỂ block: (B1) insert cap-operation; (B2) insert header — RI `FOR KEY SHARE` trên `auth.users` CHƯA pre-lock + AFTER trigger `trg_ie_reconcile_room_ins` → `recompute_room_reservation` có thể `UPDATE rooms` cần `FOR NO KEY UPDATE`, xung đột với chính `FOR SHARE` writer đang giữ trên rooms → **hai invocation đồng thời cùng room = mutual lock-upgrade deadlock 40P01**; (B3) insert items — reconcile-room lặp tới 200 lần; (B4) attach contract — fire reconcile-room lần ba. Mọi wait xảy ra khi đang giữ advisory lock + ledger FOR UPDATE + flag FOR SHARE (nghĩa là **block cả `force_freeze` của admin**) + toàn bộ witness locks.
- Protocol đích: (1) KHÔNG acquire lock mới sau final decision — pre-lock `auth.users FOR KEY SHARE`, rooms/contracts `FOR NO KEY UPDATE` thay `FOR SHARE` (diệt upgrade-deadlock), hoặc suppress reconcile triggers cho writer + gọi recompute tường minh trước decision; (2) `set_config('lock_timeout','2s',true)` + statement_timeout — 55P03/40P01 thuộc retry contract nhờ ledger; (3) lease: `clock_timestamp() + margin < LEAST(membership.valid_to, canary ends_at)` tại decision; (4) final recheck chuyển xuống NGAY TRƯỚC RETURN (sau audit + completion) — recheck hiện tại ở 1298 đứng trước hai statement còn có thể block; (5) thu hẹp advisory-lock window hoặc thay count-cap bằng atomic reservation `UPDATE ... SET used_count = used_count+1 WHERE used_count < max RETURNING`; cân nhắc bỏ FOR SHARE flag row để force_freeze không bị queue.
- Test spec (isolationtester/2-connection): duplicate-key race; claimant-abort handover; deadlock repro same-room (fail hiện tại → pass sau fix); revocation-by-write fence; time-expiry hole (`valid_to` hết hạn khi bị block — hiện commit sai); window-close mid-flight.

*Rollout/T5-infra — claim vs thực tế applied:*

- `config_version` "CAS" chỉ là cột DEFAULT 1 — KHÔNG có RPC/trigger nào bump/compare-and-swap; UPDATE mode/window/cap trực tiếp không bump → cap ledger cũ được tái dùng; bump lại re-arm cap từ 0. Retry qua config-bump ăn cap hai lần (unique theo `(feature_key, config_version, operation_key)`).
- `server_feature_flag_events` chưa có writer nào và KHÔNG có trigger append-only; `server_feature_flag_operations` không CHECK non-negative và không immutability guard.
- Evaluator APPLIED (`20260716120200`) khác evaluator trong artifact BLOCKED: bản applied KHÔNG kiểm release identity, `ON` → CANONICAL vô điều kiện, CANARY chấp nhận NULL window (unbounded), chỉ kiểm count cap — **VND cap không bao giờ được đánh giá** → "VND cap 0 = không flip" hiện KHÔNG được enforce trên live; một row ON/CANARY với identity trống + VND 0 vẫn route CANONICAL (khi count cap > 0). Bản artifact silently REPLACE function với semantics chặt (identity bắt buộc, half-open finite window, count+VND caps) và ON là uncapped-by-design — divergence phải được ghi/quyết định tường minh.
- Seed artifact dùng `ON CONFLICT (feature_key) DO NOTHING` — vi phạm chính blocker "seed/reapply không giữ im lặng row cùng key đang bật".
- Không code live nào consume evaluator (meter không gọi; frontend không gọi) — mô tả "cả canonical endpoint lẫn legacy guard cùng consume" là aspirational, chưa delivered.

### 4.4 Meter reading domain — backend partial `APPLIED`, frontend `PREPARED`, domain `BLOCKED`

- Đã cài (`20260716160000`): 5 RPC v1 create/bulk-create/update/delete/bulk-delete; 5 hook tương ứng đã wire trên branch (`4511a72`). Server set `user_id`/`recorded_by`; validate `meter_id`/`room_id` cùng org.
- Còn phải đóng trước khi domain rời `BLOCKED`: route import (`useImportMeterReadings` → legacy `bulk_create_meter_readings`), approve/bulk-approve (RPC legacy `approve_meter_reading`/`bulk_approve_meter_readings` — re-audit), unapprove (direct-UPDATE), `GenerateInvoiceDialog` và `useSubmitExcelInvoices` (direct-INSERT APPROVED); xác định feature-route semantics cho 5 RPC đã grant thẳng `authenticated`; inventory hidden callers; rồi mới drain/revoke direct DML ở T6b/T7. Full-domain target: `approved_by`/`approved_at` chỉ do path duyệt server-side (không client `status='APPROVED'`), no-duplicate theo `settlement_month`. Không gọi five-RPC subset là canonical writer duy nhất của toàn domain.

### 4.5 Contract + deposit domain (thay `useCreateContract`)

- `create_contract_v1(...)`: atomic contract + contract_customers + contract_services + room status + first invoice (gọi `create_invoice_v1`, chịu `auto_approve_invoice`); server-enforce guard "1 HĐ ACTIVE/phòng", "≥1 khách đại diện", "đủ cọc hoặc acknowledged".
- **Hold cọc 24h (27.2.6):** cọc `PENDING_APPROVAL` giữ chỗ độc quyền 24 giờ **theo server-time**, cột `expires_at`, **no double-hold** (unique/exclusion trên room khi đang hold); approve/post → reservation; reject/cancel/expiry → giải phóng; approve sau expiry re-check phòng. Cần schema mới (bảng/cột hold) — **chưa tồn tại trong code** (xem open_questions).

### 4.6 Salary/profit payout domain (thay `useSalaryPayout` + `useLockSalaryMonth`)

- `salary_payout_v1(...)`: phiếu chi lương là **force-approval class** (27.2.4) → luôn qua checker, không self-approve; atomic {income_expenses EXPENSE + items; nếu gạch nợ tiền phòng: payment method `CT` + income_expenses INCOME + items; update salary_monthly.paid}. Payment gạch nợ **phải đi qua `record_invoice_payment_v3`** (T1b) thay vì insert `payments` trực tiếp — loại double-writer.
- `lock_salary_month_v1`: việc tự duyệt phiếu hoa hồng (`income_expenses.approval_status='APPROVED', approved_by=user.id`) hiện là self-approve force-approval class → phải route qua checker/engine T3; `approved_by` server-set.

---

## 5. Test evidence theo từng slice — hiện chỉ partial/historical

Meter backend có direct JWT evidence được tracker ghi nhận, nhưng chưa có full writer-drain, frontend-production, feature-route, canary và observation evidence. Income/expense BB0C concurrency evidence đã stale sau khi source đổi; adapter/lint pass source-local không thay thế fresh exact-source PostgreSQL compile/concurrency/hash evidence. Mỗi slice chỉ được nâng trạng thái theo evidence bind vào exact release identity của chính slice đó. Mỗi domain-slice phải đạt toàn bộ danh sách dưới trước khi rời `IN_DESIGN`:

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

T5 gom nhiều domain; theo 27.4 phải cutover **từng domain một qua cùng gate**, không một lần đổi tất cả. Không "vá thêm flag rồi gọi là xong": mỗi domain-slice cần RPC canonical explicit org boundary + state machine + idempotency + audit + reconciliation. Dependency xác định theo đúng subject/effect của slice: meter CRUD partial không phụ thuộc T1b/T3 như money posting, nhưng money/reversal/salary slices phải đạt các dependency tương ứng (T1b/T2/T3/T4a/T6a). Không slice nào được gọi là full-domain cutover hoặc `VERIFIED` nếu chưa có T4a evidence, ORG/domain closure, complete writer map, rollout/canary, drain proof và owner approval của chính slice. Trạng thái hiện tại: **NO-GO cho mọi production activation mới**.