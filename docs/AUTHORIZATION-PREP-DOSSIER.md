# AUTHORIZATION-PLAN — Dossier chuẩn bị để review (Sprint 5→7 còn lại)

> Tạo: 2026-07-13. Branch: `security/authz-preparation` (KHÔNG merge vào `main` cho tới khi bạn duyệt).
> Nguồn: [AUTHORIZATION-PLAN.md](./AUTHORIZATION-PLAN.md) + [AUTHORIZATION-IMPLEMENTATION-STATUS.md](./AUTHORIZATION-IMPLEMENTATION-STATUS.md) + inventory quét catalog toàn codebase (5 agent, 2026-07-13).
>
> **Quyết định của owner (2026-07-13)**: *Chuẩn bị TẤT CẢ để review trước; KHÔNG áp phần rủi ro lên live.* Dossier này là "bức tranh trọn" để bạn (hoặc audit độc lập) ký duyệt trước khi mở cửa sổ bảo trì.

## Giao kèo review (đọc trước)

| Loại thay đổi | Nơi để | Áp lên live khi nào |
|---|---|---|
| **Additive** (RPC mới, cột mới nullable, feature-flag OFF) — Nhóm A + B-i1 | `supabase/migrations/` (bình thường) | Có thể áp bất kỳ lúc nào; **không đổi hành vi** tới khi hook được wire + verify |
| **Enforcement/revoke/cutover** — Nhóm B-money flips, B-i2..i5 | `supabase/migrations-pending-window/` (KHÔNG chạy bởi migrate thường) | **Chỉ** trong maintenance window, canary trước, có go/no-go ký tên |

Mỗi file migration đều mở đầu bằng header `-- STATUS: PREPARED (chưa áp live) | APPLIED <ngày>`.

---

## Nền đã có — KHÔNG làm lại

- **Thu tiền khách atomic**: `record_invoice_payment_v3` (payment+invoice+voucher+items+idempotency+owner-attribution), đã wire `useRecordPaymentRPC`/`useBulkRecordPayment`/`useCreatePayment`. (Sprint 5b/5b2/5b3)
- **Ranh giới tổ chức**: `organization_id` trên 132 bảng + trigger `_autofill_org` + RESTRICTIVE org-boundary trên **28 bảng lõi**. (Sprint 3)
- **Máy duyệt (schema + RPC)**: 9 bảng approval + `submit_financial_voucher`/`decide_financial_voucher`/`_eval_approval_rule`/`_post_financial_voucher`/`emergency_approve_financial` — **nhưng 0 nơi gọi từ UI** (đó là B-i1).
- **Chống giả mạo audit**: guard cột `approved_by`/posting metadata cho client. (Sprint 5a)
- **ACL definer + CI gate**: `scripts/check-definer-acl.mjs`. (Sprint 6a)

---

## Tổng: **51 hạng mục ≈ 163 ngày công** (thực tế 160–235 ngày ≈ 8–11 tháng, 1 dev cẩn thận)

| Nhóm | Hạng mục | Ngày | Áp live |
|---|---:|---:|---|
| **A — An toàn (additive)** | 14 | 26 | Liên tục, không window |
| **B-money — hook tiền cần flip** | 28 | 77 | Từng flow, feature-flag, canary, window cho bước flip |
| **B-infra — cutover nền** | 5 | 51 | Window bắt buộc, canary + negative test |
| **C — Vận hành/dọn dẹp** | 4 | 9 | Quanh các window |
| **Tổng** | **51** | **163** | |

---

## GROUP A — An toàn, làm ngay (14 hạng mục · 26 ngày)

Additive: viết RPC → trỏ hook → test. Đường cũ vẫn chạy tới khi B-i5 revoke. **Không downtime, không đổi quyền nhân viên.**
Ý nghĩa nghiệp vụ: mọi tạo/sửa phiếu & hóa đơn thành **1 giao dịch nguyên tử** — hết "hóa đơn rỗng đã trừ cọc / sửa mất dòng / bấm lại tạo trùng".

| # | Hook (file:line) | RPC đích | RPC đã có? | Migration chuẩn bị | Ngày | Trạng thái tranche |
|---|---|---|:---:|---|---:|---|
| A1 | `useApproveInvoice` (useInvoices.ts:937) | `approve_invoice` | ❌ | `..._approve_invoice.sql` | 1.5 | ☐ chưa |
| A2 | `useBulkApproveInvoices` (useInvoices.ts:1041) | `approve_invoice` (loop) | ❌ | ↑ | 1 | ☐ chưa |
| A3 | `useCheckOverdueInvoices` (useInvoices.ts:1197) | `check_overdue_invoices` | ❌ | `..._check_overdue.sql` | 1 | ☐ chưa |
| A4 | `useCreateInvoice` (useInvoices.ts:606) | `create_invoice_draft` | ❌ | `..._invoice_draft.sql` | 2.5 | ☐ chưa |
| A5 | `useUpdateInvoice` (useInvoices.ts:747) | `update_invoice_draft` | ❌ | ↑ | 2 | ☐ chưa |
| A6 | `generateMonthlyInvoice` (invoiceHelpers.ts:746) | `create_invoice_draft`/`submit_invoice` | ❌ | ↑ | 1 | ☐ chưa |
| A7 | `useUpdatePaymentMethod` (useUpdatePaymentMethod.ts:116) | `change_payment_method_atomic` | ❌ | `..._change_pay_method.sql` | 1 | ☐ chưa |
| A8 | `useCreateIncomeExpense` (mutations.ts:29) | `create_financial_draft` | ❌ | `..._financial_draft.sql` | 3 | ☐ chưa |
| A9 | `useUpdateIncomeExpense` (mutations.ts:110) | `update_financial_draft` | ❌ | ↑ | 2.5 | ☐ chưa |
| A10 | `useQuickUpdateIncomeExpense` (mutations.ts:196) | harden `update_income_expense_quick` | ✅ (harden) | `..._quick_harden.sql` | 1.5 | ☐ chưa |
| A11 | Excel voucher import (batch.ts:32) | `create_financial_draft` (batch) | ❌ | ↑ A8 | 2.5 | ☐ chưa |
| A12 | Batch N phiếu con (batch.ts:130) | `create_financial_draft` (batch) | ❌ | ↑ A8 | 3 | ☐ chưa |
| A13 | AI copilot draft (copilot/writeTools.ts:126) | `create_financial_draft` | ❌ | ↑ A8 | 1.5 | ☐ chưa |
| A14 | Phiếu định kỳ (recurring.ts:36) | siết policy trong `generate_recurring_vouchers_v2` | ✅ (harden) | `..._recurring_harden.sql` | 2 | ☐ chưa |

> **Bẫy trong A**: A4/A6 cũng ghi `excess_amounts` (cọc thừa/credit). Khi gộp credit vào RPC, phải dời luôn insert thô ở `useBulkRecordPayment.ts:318` ("Nợ khách giữ lại") vào server cùng đợt, không thì lệch sổ credit.

---

## GROUP B-money — hook tiền phải flip (28 hạng mục · 77 ngày)

Phần "kiểm soát tài chính" thật: bỏ tự-duyệt, hủy/hoàn → **bút toán đảo có audit** (không xóa cứng), lương/lợi nhuận/hoàn cọc/đặt cọc/duyệt công tơ → **bắt buộc qua duyệt**. Mỗi cái **đổi cách làm việc hằng ngày** ⇒ cần bạn chốt + window.

| # | Hook (file:line) | Lý do cần window | RPC đích | Ngày |
|---|---|---|---|---:|
| B1 | `useUnapproveInvoice` (useInvoices.ts:989) | un-approve phá finality khi đã có payment/AR | reversal | 1.5 |
| B2 | `useCancelInvoice` (useInvoices.ts:1541) | cancel bỏ qua state machine/side-effect | `cancel_invoice` | 2 |
| B3 | `useForceCancelInvoice` (useInvoices.ts:1502) | xóa cứng row tiền → chỉ support-repair có audit | repair-only | 1 |
| B4 | `useRestoreInvoice` (useInvoices.ts:1451) | CANCELLED→APPROVED tái tạo hiệu ứng tiền | reversal/repair | 1.5 |
| B5 | `useDeletePayment` (useDeletePayment.ts:44) | xóa cứng payment/excess → đảo phiếu | `reverse_invoice_payment` | 1.5 |
| B6 | `useApproveVoucher` (statusMutations.ts:12) | **hôm nay creator tự duyệt phiếu mình** → maker-checker | `decide_financial_voucher` | 2 |
| B7 | `useUnapproveVoucher` (statusMutations.ts:39) | phá finality ledger | `reverse_financial_posting` | 2 |
| B8 | `useCancelIncomeExpense` (statusMutations.ts:77) | split-brain UPDATE + hard DELETE payment | `cancel_or_reverse_voucher` | 2.5 |
| B9 | `useRestoreIncomeExpense` (statusMutations.ts:131) | super-admin tái tạo tiền | repair-only | 1.5 |
| B10 | Hủy cả batch (batch.ts:234) | bulk cancel + bulk hard-delete payment | batch reversal | 2 |
| B11 | Đổi sổ quỹ cả batch (batch.ts:303) | tái gán tiền đã post, không guard | RPC có guard | 2 |
| B12 | Tiêu credit/cọc thừa (useContractOperations.ts:269) | ghi `excess_amounts` âm ngoài txn thanh lý | trong `submit_contract`/RPC | 2.5 |
| B13 | `useLockSalaryMonth` (useManagerSalary.ts:648) | **chốt lương auto-duyệt hoa hồng (tự duyệt)** | `lock_salary_period` (chỉ snapshot) | 5 |
| B14 | `useSalaryPayout` (useManagerSalary.ts:769) | 5–7 request rời post lương + cấn nợ phòng | `request_salary_payout` | 6 |
| B15 | Chia lợi nhuận (specialized.ts) | DB-default APPROVED → phải là request | `request_profit_distribution` | 3 |
| B16 | Chi quản lý/điều hành (specialized.ts) | DB-default APPROVED → phải là request | `request_manager_payout` | 3 |
| B17 | Hoàn cọc thanh lý (useInvoicePayments.ts:302/357) | refund post EXPENSE APPROVED thẳng | `request_settlement_refund` | 3 |
| B18 | Cọc giữ chỗ — nhanh (QuickDepositModal.tsx) | cọc APPROVED → khóa phòng ngay; flip đổi UX | `create_reservation_deposit` | 3 |
| B19 | Cọc giữ chỗ — dialog đầy đủ (CreateDepositDialog.tsx) | insert tenant trước voucher → split-brain | ↑ | 2 |
| B20 | Tạo hợp đồng (useContractSubmit.ts + useContracts.ts:650) | HĐ+khách+HĐ đầu+cọc, nhiều request rời | `submit_contract` + outbox | 8 |
| B21 | Duyệt/hủy chỉ số công tơ (useMeterReadings.ts) | client tự duyệt input tính tiền | RPC bulk/approve immutable | 3 |
| B22 | Chỉ số + hóa đơn (GenerateInvoiceDialog.tsx) | reading APPROVED (nuốt lỗi) + invoice rời | `generate_meter_reading_and_invoice` | 4 |
| B23 | Batch chỉ số+HĐ theo tòa (useExcelInvoiceData.ts) | partial-success, retry tạo trùng | ↑ + idempotency | 2 |
| B24 | Tạo sổ quỹ + số dư đầu (useAccounts.ts:159) | số dư đầu kỳ là tiền ngoài ledger | `create_cashbook`(bal=0)+`request_opening_balance_adjustment` | 3 |
| B25 | Sửa sổ quỹ/chủ sở hữu (useAccounts.ts:196) | hồi tố số dư đầu + đổi scope | `update_cashbook_metadata` (cấm sửa balance/owner) | 3 |
| B26 | Khóa/mở kỳ (useAccounts.ts:266) | mở lại kỳ đã đóng, không guard | `lock/unlock_cashbook_period` | 3 |
| B27 | Lưu trữ sổ quỹ (useAccounts.ts:238) | soft-delete không guard số dư/dependency | `archive_cashbook` | 2 |
| B28 | Đóng tiền điện/nước (usePeriodFees.ts:216) | post APPROVED thẳng thay vì request | utility → request | 2 |

---

## GROUP B-infra — cutover nền (5 hạng mục · 51 ngày)

| # | Track | Nội dung | Ngày | Rủi ro |
|---|---|---|---:|---|
| **B-i1** | **Nối máy duyệt** | `submit/decide_financial_voucher` có sẵn nhưng **0 caller**; build **`reverse_financial_posting`** (chưa có); surface emergency-approve; tiêu `authorization_version` để bust cache quyền. **Điều kiện tiên quyết của B1/B5/B7/B8.** | 8 | Thấp (additive — có thể làm ở Nhóm A) |
| **B-i2** | **RLS v2 cutover** | ~552 policy owner-graph cũ vẫn là bề mặt đọc/ghi thật; org-boundary hiện chỉ additive-restrictive. Viết lại deny-default theo từng domain + same-org constraint + negative REST test, đọc-trước-ghi-sau. **Rủi ro nhất.** | 20 | **Cao** |
| **B-i3** | **ACL hàm toàn schema** | Nay chỉ có CI diff-gate. Làm `REVOKE EXECUTE … FROM PUBLIC/anon` toàn schema + allowlist theo signature, pin `search_path`, dời impl vào schema private ngoài PostgREST. | 10 | Cao (thiếu 1 hàm trong allowlist → hàm đó ngừng chạy) |
| **B-i4** | **Storage cutover** | 8 bucket còn authenticated-wide (user login bất kỳ đọc file tổ chức khác nếu đoán path) + 4 policy mồ côi `room-sale-images` (có anon SELECT). Build `storage_object_links`, re-path `<org>/<resource>/<id>/…`, scoped policy, dual-read khi migrate. | 10 | Cao (đổi policy trước khi re-path xong → vỡ đọc ảnh/receipt) |
| **B-i5** | **Drain + REVOKE DML** (Sprint 7.2) | `REVOKE INSERT/UPDATE/DELETE ON income_expenses/invoices/meter_readings/accounts FROM authenticated`. **Chỉ áp khi MỌI path A + B-money đã lên RPC.** Cửa một chiều cuối. | 3 | **Cửa một chiều** |

---

## GROUP C — Vận hành/dọn dẹp (4 hạng mục · 9 ngày)

| # | Item | Ngày | Chặn bởi |
|---|---|---:|---|
| C1 | Dashboard giám sát (deny-rate/error) + shadow log trên canary (Sprint 7.1) | 4 | — (làm trước flip đầu tiên) |
| C2 | Drop legacy policy/RPC/JSON sau retention (Sprint 7.5) | 2 | B-i2 xong |
| C3 | Regen `src/integrations/supabase/types.ts` sau RPC mới (Sprint 7.6) | 1 | mỗi tranche RPC |
| C4 | Training owner/admin + runbook break-glass/rollback (Sprint 7.4/7.6) | 2 | — |

---

## Thứ tự thực thi (KHÔNG đảo — plan §27)

1. **B-i1 nối máy duyệt (8d)** — build `reverse_financial_posting`, wire submit/decide. Nền cho mọi B-money "reversal-based".
2. **Toàn bộ Nhóm A (26d)** — additive, không window, verify browser từng RPC. Gỡ 2/3 path an toàn.
3. **B-money từng flow (77d)** — mỗi flow sau feature-flag, canary, **bật C1 giám sát trước cú flip đầu**. Chốt thứ tự flip (cọc-khóa-phòng, lương, hoàn cọc, duyệt công tơ) với owner.
4. **B-i5 REVOKE DML (3d)** — chỉ sau khi MỌI A + B-money đã lên RPC. **Điểm không quay lại.**
5. **B-i2 RLS v2 (20d)** — từng domain, đọc-trước-ghi-sau, drop policy cũ chỉ khi thay thế đã chứng minh.
6. **B-i4 Storage (10d)** — copy-not-delete re-path + dual-read signed URL, rồi scoped policy, rồi dọn anon `room-sale-images`.
7. **B-i3 ACL hàm (10d)** — pass hardening cuối khi allowlist RPC đã ổn định.
8. **C2/C3/C4** — sau retention.

## Cửa GO/NO-GO — KHÔNG áp live nếu thiếu window + lệnh owner

- Bất kỳ `REVOKE … ON income_expenses/invoices/meter_readings/accounts` (B-i5) — cửa cuối; sót 1 flow là flow đó ngừng ghi cho user thật.
- Thay policy RLS v2 (B-i2) — sót 1 bảng = rò xuyên tổ chức hoặc mất row hợp lệ.
- Đổi policy Storage + re-path (B-i4) — swap trước khi re-path xong = vỡ đọc ảnh/receipt.
- REVOKE ACL hàm toàn schema (B-i3) — hàm thiếu allowlist ngừng chạy.
- Các flip quyền (B6/B7 bỏ tự-duyệt, B13–B18 lương/lợi nhuận/hoàn cọc/cọc → bắt buộc duyệt, B21 duyệt công tơ, B26 khóa kỳ) — đổi việc nhân viên làm **hôm nay**.
- B3/B5/B8/B9 xóa-cứng → đảo phiếu — đổi cách hủy và đụng tiền đã post.

---

## Convention RPC (chuẩn từ `20260713130200_sprint4c` + `..._5b_payment_atomic_v3`)

Mọi RPC canonical viết theo mẫu đã có trong repo:
- `LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'`.
- `v_uid := auth.uid()`; NULL → `RAISE EXCEPTION '...' USING ERRCODE='42501'`.
- Resolve org membership; non-member + non-super → 42501.
- `SELECT ... FOR UPDATE` lock subject; idempotency qua `(org, operation, idempotency_key)` hoặc "one-open-request".
- Ghi phiếu/hóa đơn + items + credit + posting **trong cùng transaction**; approval đi qua `submit_financial_voucher`/`decide_financial_voucher`.
- Grant: `REVOKE ALL … FROM PUBLIC, anon`; `GRANT EXECUTE … TO authenticated`; helper `_...` revoke cả `authenticated`.

## Tracker giao hàng (cập nhật mỗi tranche)

| Tranche | Nội dung | Commit | Trạng thái |
|---|---|---|---|
| T0 | Branch + dossier này | (this) | ✅ |
| T1 | B-i1: `reverse_financial_posting` + wire submit/decide (schema-verified) | — | ☐ kế tiếp |
| T2 | Group A RPC migrations (additive, PREPARED) | — | ☐ |
| T3 | Group A hook wiring + feature flag + test | — | ☐ |
| T4+ | B-money từng flow (PENDING-WINDOW) | — | ☐ |
| … | B-infra i2/i3/i4/i5 (PENDING-WINDOW) | — | ☐ |
