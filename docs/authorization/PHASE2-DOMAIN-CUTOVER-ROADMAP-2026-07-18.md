# PHASE 2 — Domain cutover roadmap (frontend→canonical) — 2026-07-18

> Sinh từ workflow phân tích 13-agent (read-only) đối chiếu frontend write-sites vs
> canonical writer thật trên production. Đây là ROADMAP thực thi cho phần còn lại
> của chương trình authorization (sau khi backend hardening + payment cutover xong).
>
> **Sự thật quy mô (đọc trước):** mọi domain đều HIGH. Tổng ~35+ writer canonical
> PHẢI VIẾT MỚI (payload-parity) trước khi wire — nhiều writer hiện có DROP field
> (silent data loss nếu wire nguyên trạng). Chỉ **meter CRUD** wire/test được ngay.
> Đây là chương trình nhiều phiên, mỗi domain một "window nhỏ" + browser test.
>
> **Nguyên tắc an toàn giữ nguyên:** (1) KHÔNG wire writer non-parity as-is (mở rộng
> parity trước). (2) Adapter-fallback mọi chỗ (canonical→legacy khi lỗi; 23505 KHÔNG
> fallback). (3) Flag OFF mặc định → app chạy legacy → 0 regression cho tới khi
> browser-verify từng domain rồi mới bật. (4) Payment coupling: mọi DELETE payments
> phải route reverse_invoice_payment_v3.

## Kế hoạch thực thi tổng hợp

# KẾ HOẠCH THỰC THI CUTOVER AUTHORIZATION — 6 DOMAIN

## 0. Nhận định cắt ngang (đọc trước)

**Hạ tầng dùng chung — viết 1 lần, xài mọi domain:** tất cả adapter bám mẫu `src/lib/paymentRecordRpc.ts` — build args thuần → gọi canonical → `classify` lỗi (`PGRST202` not-deployed / `55000` "chưa bật" / `42501` v-denied → fallback legacy; `23505` **KHÔNG BAO GIỜ** fallback). Mỗi write-site có `src/lib/<name>Rpc.ts` (buildArgs + classify + fallback), hook chỉ truyền `supabase.rpc` để test được.

**Grant-gate chặn end-to-end test toàn bộ (trừ meter):** mọi writer canonical đã APPLIED nhưng `EXECUTE` chỉ `postgres` (revoked khỏi `authenticated`) + flag OFF sau revert. Tới khi owner re-grant + bật flag org canary, adapter luôn nhận `42501/PGRST202` → chạy 100% legacy (an toàn nhưng **không test được đường canonical trên browser**). **NGOẠI LỆ: meter** — 5 writer CRUD đã LIVE (`authenticated=t`), test được ngay.

**Payment coupling xuất hiện ở 3 domain khác** (income-expense, salary, contract terminate) — mọi chỗ raw `DELETE payments` phải route qua `reverse_invoice_payment_v3`, mọi chỗ thu tiền phòng phải qua `record_invoice_payment_v4`. Payment ĐÃ xong nên đây là dependency sẵn sàng, không phải blocker.

---

## 1. Xếp hạng domain theo (độ dễ × giá trị)

| # | Domain | Trạng thái writer | Có làm TRỌN bằng adapter-fallback ngay? | Risk |
|---|--------|-------------------|------------------------------------------|------|
| **A** | **meter (CRUD + import)** | 5 CRUD writer LIVE | ✅ Phần lớn xong; còn 1 bug import + 3 writer nhỏ | LOW→MED |
| **B** | **cashbook (create/lock/archive)** | 4/6 sẵn sàng (create, lock, unlock, archive) | ⚠️ 4 op wire được ngay; metadata+share chờ 2 writer | MED |
| **C** | **income-expense (create đơn)** | 1 writer + builder đã có | ⚠️ 1 create-path wire được; 5-7 writer còn thiếu | HIGH |
| **D** | **invoice (state-machine)** | 0/9 state writer (đơn giản) | ❌ Phải viết 9 guarded-UPDATE writer trước | HIGH |
| **E** | **deposit-contract (renew/transfer/terminate)** | 0 v1, nhưng legacy authz-aware làm fallback | ❌ Viết 5 v1; create cần v2; model cọc phải chốt | HIGH |
| **F** | **salary** | Nhiều writer thiếu + cascade payment | ❌ Phức tạp nhất, compound multi-table | HIGH |

**Đề xuất thứ tự thực thi = A → B → C → D → E → F** (ease+value). Lệch nhẹ §27.3 (invoice trước): **cố ý** — invoice state-machine tuy giá trị cao nhưng cần viết 9 writer mới, trong khi meter/cashbook có writer sẵn để lấy "quick win" xác lập pattern adapter trước. Nếu owner ưu tiên §27.3 cứng thì đảo D lên sau B.

---

## A. METER — quick win, làm ngay (LOW→MED)

**LOW-risk, wire được NGAY (writer LIVE, không cần fallback):** 5 site CRUD ở `src/hooks/useMeterReadings.ts` đã hard-cutover xong (`:269, :306, :414, :451, :479`). Không đụng.

**Việc cần làm, theo độ khó tăng dần:**

1. **[SỬA NGAY — không cần writer] Bug import Excel** `useMeterReadings.ts:359`: đang gọi `bulk_create_meter_readings` với `p_readings=JSON.stringify(...)` + `p_user_id` → prod chỉ có overload `(p_readings jsonb)` → PostgREST không resolve → **import HỎNG runtime**. Rewire sang `bulk_create_meter_readings_v1(p_readings jsonb)`: bỏ `p_user_id`, bỏ `JSON.stringify` (truyền array). Cần resolve `meter_code→meter_id` client-side (v1 nhận `meter_id`, import có `meter_code`).
2. **[XOÁ dead code]** `useInvoices.ts:1300` (`useRecordMeterReading`) + `:1404` (`useBulkCreateMeterReadings` bản trùng tên) — không caller. Xoá để giảm bề mặt direct-DML.
3. **[VIẾT writer + adapter] Unapprove** `useMeterReadings.ts:581` — direct-DML `.update({status:UNAPPROVED,...})`, **cửa hở lớn nhất**. Viết `unapprove_meter_reading_v1(p_id)` → adapter fallback direct-DML.
4. **[VIẾT writer + adapter] Approve/bulk-approve** `:516/:548` — legacy `approve_meter_reading`/`bulk_approve_meter_readings` (còn `authenticated=t`). Viết `approve_meter_reading_v1` + `bulk_approve_meter_readings_v1`, adapter fallback về legacy (an toàn).
5. **[HIGH — deferred] Atomic meter+invoice** `GenerateInvoiceDialog.tsx:490` + `useExcelInvoiceData.ts:183` + `useInvoices.ts:606` — deliverable chính nhưng **BLOCKED**: writer `create_invoice_with_reading_v1` bao trọn tạo invoice → phải cutover invoice-domain trước/đồng thời. Để lại tranche invoice.

**⚠️ Cần chốt với owner trước khi coi CRUD "xong":** `create_meter_reading_v1` ép `status='APPROVED'` + `approved_by=caller`, **ngược** docstring hook (ghi 'UNAPPROVED') và ngược UI "ghi chỉ số chờ duyệt". Nếu nghiệp vụ kỳ vọng reading mới = UNAPPROVED thì writer đang **tự-duyệt SAI**.

**Browser test:** ghi đơn/bulk (LIVE ngay) → **import Excel (test trước & sau vá bug)** → unapprove → approve/bulk-approve.

---

## B. CASHBOOK — 4 op ship trước, 2 op chờ writer (MED)

**Ship được NGAY qua adapter (writer đã VERIFIED trên prod):**

| Write-site | Writer | Ghi chú GAP |
|---|---|---|
| `useAccounts.ts:176` create | `create_cashbook_v1` | Writer DROP `description`, ép `is_default=false`, **bỏ qua** admin-set `user_id` (ép owner=auth.uid()); **yêu cầu** `p_idempotency_key` (FE phải `crypto.randomUUID`); trả `{cashbook_id}` không phải full row → map `cashbook_id→id` cho `CashbookForm.tsx:141` |
| `useAccounts.ts:270` lock | `lock_cashbook_period_v1(id, lock_date, false)` | Map sạch; guard monotonic (không lùi khoá) = hành vi MỚI |
| `useAccounts.ts:297` unlock | `lock_cashbook_period_v1(id, null, true)` | Map sạch |
| `useAccounts.ts:242` delete | `archive_cashbook_v1` | **Behavior change**: từ chối archive khi còn phiếu → adapter phải surface message `55000 'còn N phiếu'` |

**Chờ 2 writer MỚI (confirmed absent pg_proc) + UI mới:**

1. **[VIẾT] `update_cashbook_metadata_v1`** cho `useAccounts.ts:214` — SPLIT `useUpdateAccount` thành 2 đường:
   - (a) metadata thuần (name/description/quick_default_building_id/user_id) → writer mới.
   - (b) đổi `initial_amount` → **KHÔNG overwrite raw**; route qua `request_opening_balance_adjustment_v1` (đã có nhưng **ZERO call-site**) = forward-fix compensating voucher (delta = new − old + reason). **Cần UI mới** bắt delta + reason.
2. **[VIẾT] `set_cashbook_shared_users_v1`** cho `useAccountSharedUsers.ts:85+101` — chuyển whole-list-diff từ client về server.

**⚠️ Note tích cực:** direct-DML create hiện **KHÔNG** set `organization_id`, mà `accounts_org_boundary` RESTRICTIVE đã live → canonical create thực ra **VÁ** latent gap. Nhưng `create_cashbook_v1` fail-closed nếu actor có >1 ACTIVE membership → **admin đa-org bị chặn**.

**Browser test (trên DB restore, không prod):** tạo sổ (verify org set + parity description/is_default) → lock+ghi phiếu ≤ lock_date (chặn P0001) + unlock → archive RỖNG (OK) vs CÒN phiếu (từ chối) → [chờ writer] rename metadata + điều chỉnh số dư đầu kỳ + share user.

---

## C. INCOME-EXPENSE — 1 create-path ship, phần lớn chờ writer (HIGH)

**Ship được (builder đã VERIFIED khớp 1:1):**

- `useCreateIncomeExpense` `mutations.ts:29` → `create_income_expense_v1`. Builder `src/lib/incomeExpenseCreateRpc.ts` **đã có** (chỉ dùng trong test) — cần thêm lớp routing + telemetry. **CHỈ non-recurring**; nếu `repeat_* != NONE` → đi thẳng legacy (v1 CHẶN recurring).
- `useImportIncomeExpenses` `batch.ts:34` → tái dùng adapter #1 per-row (idempotency key = row hash).

**Chờ WRITER MỚI (5-7 cái — bulk công việc):**

| Writer thiếu | Cho write-site |
|---|---|
| `update_income_expense_v1` (+replace items atomic, nhánh repeat_* / stop-recurring) | `mutations.ts:112/151/172`, `recurring.ts:16` |
| `cancel_income_expense_v1` (**PHẢI tự gọi `reverse_invoice_payment_v3`**, bỏ raw DELETE payments) | `statusMutations.ts:77/88`, `batch.ts:236/251` |
| `create_income_expense_batch_v1` (batch+N phiếu+items+junction 1 TX) | `batch.ts:108/132/180/189` |
| `create_profit_distribution_v1` (shareholder_id — v1 KHÔNG có) | `specialized.ts:51/72/98` |
| `create_manager_salary_payout_v1` (profit_manager_id; `salary_payout_v1` là STAFF, **mis-map**) | `specialized.ts:167/188/214` |
| `create_income_expense_recurring_v2` (hoặc mở rộng v1 nhận repeat_*) | `mutations.ts:47-58` |

**GIỮ nguyên (đã DEFINER RPC):** `approve_voucher`/`unapprove_voucher`/`restore_income_expense`/`verify_income_expense`/`update_income_expense_quick`/`generate_recurring_vouchers_v2`/`log_income_expense_action`. Ưu tiên thấp, không chặn cutover DML.

**🔴 Rủi ro #1 — CROSS-DOMAIN CASCADE:** `statusMutations.ts:88` + `batch.ts:251` xoá thẳng bảng `payments`. Payment ĐÃ cutover → `cancel_income_expense_v1` **PHẢI** gọi payment reversal writer, tuyệt đối không raw DELETE, kẻo lệch `invoice.paid_amount`/status.

**Browser test:** tạo phiếu đơn (canonical khi flag ON / legacy khi OFF) → phiếu LẶP (vẫn legacy, không vỡ) → sửa phiếu UNAPPROVED → **huỷ phiếu THU mirror có payment_id (verify không mồ côi payment + invoice recompute)** → batch tạo/huỷ/đổi sổ → chia lợi nhuận + lương điều hành → import Excel → đối chiếu sổ quỹ SUM khớp.

---

## D. INVOICE — 9 state-writer (đơn giản nhưng nhiều), create/update bị chặn (HIGH)

**Chia 2 nhóm rõ rệt:**

### D1 — STATE-MACHINE (làm TRƯỚC — mỗi cái là 1 guarded-UPDATE→RPC, no payload gap)
Viết 9 writer (confirmed absent), rồi wire adapter fallback (fallback = UPDATE hiện tại):

| Writer | Write-site | Fallback |
|---|---|---|
| `approve_invoice_v1` | `useInvoices.ts:937` | `.eq(status,DRAFT)` |
| `unapprove_invoice_v1` | `:987` | `.eq(status,APPROVED)` |
| `cancel_invoice_v1` | `:1539` | UPDATE→CANCELLED (FE hiện **NO guard** — writer quyết legal source states) |
| `restore_invoice_v1` | `:1450` | phải re-check partial-unique `(contract_id,billing_month)` |
| `delete_invoice_v1` | `:852` | soft-delete + canDelete guard |
| `bulk_approve_invoices_v1` | `:1039` | batch |
| `bulk_delete_invoices_v1` | `:896` | batch DRAFT-only |
| `check_overdue_invoices_v1` | `:1197` | **org/building-scoped** (FE chạy UNSCOPED mỗi page-load → viết writer scoped+idempotent-cheap) |
| `update_invoice_note_v1` | `useUpdateInvoiceNote.ts:22` | notes-only (có thể fold vào update) |

`super_admin_force_cancel_invoice` `:1502` — đã RPC, chỉ confirm route/revoke parity.

### D2 — CREATE/UPDATE (BLOCKED — 🔴 SILENT DATA LOSS)
**KHÔNG wire `useCreateInvoice` (`:606/640/671`) vào `create_invoice_v1` hiện tại.** Writer DROP: `notes, discount_notes, prepaid_amount`(ép 0)`, previous_debt_sources, template_id, electricity_prev_overridden`, `applied_credit→excess_amounts`, và per-item DROP `service_id, coefficient, previous_reading, current_reading, from_date, to_date`. Wire as-is = **vỡ meter line-items, prorated rent (`useInvoiceRentPeriods`), first-month detection (`useFirstInvoiceDetails`), credit consumption**.
→ **PHẢI viết `create_invoice_v1_v2` parity-extension** (bao cả `excess_amounts` atomic) trước. Rồi wire `useUpdateInvoice` (`:747/773/797`) → `update_invoice_v1` (cũng phải viết). First-month auto (`useContracts.ts:650/695`) wire qua `create_contract_v1(p_first_invoice)` **sau khi** parity-extension land (hiện `create_contract_v1` hardcode first-invoice discount=0).

**XOÁ dead code:** `invoiceHelpers.ts:746/778` (`generateInvoiceForContract` — schema cols không tồn tại).

**Browser test:** duyệt/bỏ duyệt/bulk → huỷ→phục hồi (chặn trùng kỳ) → xoá soft/bulk → note đứng-một-mình từ CollectDrawer → sweep quá hạn → **[sau extension] tạo HĐ có item điện/nước + prorate RENT + credit → verify mọi field persist + excess_amounts trừ đúng**.

---

## E. DEPOSIT-CONTRACT — legacy làm fallback, nhưng model cọc phải chốt (HIGH)

**NHÓM 1 (dễ nhất — legacy authz-aware đã khớp payload 1:1 làm fallback an toàn):**
Viết 5 canonical v1 (ledger+idempotency+route) rồi tạo `src/lib/contractOpsRpc.ts`, wire `useContractOperations.ts`:

| Writer mới | Site | Legacy fallback (đã có) |
|---|---|---|
| `renew_contract_v1` | `:23` | `renew_contract` |
| `transfer_room_v1` | `:62` | `transfer_room` |
| `transfer_contract_v1` | `:147` | `transfer_contract` |
| `terminate_contract_forfeit_v1` (**hấp thụ** `consumeRemainingCredit` `:269`) | `:188` | `terminate_contract_forfeit` |
| `terminate_contract_move_out_v1` (hấp thụ credit) | `:310` | `terminate_contract_move_out` |

→ BỎ `consumeRemainingCredit` client-side (non-atomic post-RPC) sau khi writer hấp thụ.

**NHÓM 2 (direct-DML thuần, fallback = giữ DML):** viết `register_move_out_v1` (`:108`), `delete_contract_v1` (`useContracts.ts:1059`), `update_contract_v1`+sync (`:891/940/990`).

**NHÓM 3 (khó nhất — create):** **KHÔNG wire `create_contract_v1` as-is.** Thiếu ~12 field (`payment_cycle, start/end_billing_date, templates, notes, discounts, deposit_debt_*, deposit_paid`, per-customer `is_representative`, per-service `initial_reading`, `firstInvoiceDiscount`). Mở rộng `create_contract_v2` + hấp thụ phiếu thu cọc THẬT (income_expenses) + flip `deposits CONVERTED` (hiện non-atomic post-RPC `useContractSubmit.ts:308/350`). Fallback = chuỗi 5-bước DML hiện tại.

**NHÓM 4 (DEFER — chốt model trước):** 🔴 3 đường cọc song song — `room_reservation_holds` (`create_reservation_deposit_v1`), `income_expenses is_deposit` (QuickDepositModal/useContractSubmit — **model THỰC**), bảng `deposits` (`useCreateDeposit`). **Chốt với owner** đâu là model đích trước khi wire, kẻo double-count / mất trạng thái RESERVED.

**DỌN:** xoá `useApproveTermination/useRejectTermination/usePendingTerminations/useBulkCreateContracts` (`useContracts.ts:1373`… — dead, raw `cash_book`/`contract_terminations` DML).

**Browser test:** tạo HĐ (verify contract+customers[is_representative]+services[initial_reading]+invoice+phiếu thu cọc+rooms OCCUPIED) → gia hạn/chuyển phòng/nhượng → đăng ký move-out → thanh lý forfeit (excess âm) + move-out (shortfall PAID vs DEBT) → xoá HĐ (chặn khi có invoice) → QuickDeposit (rooms RESERVED realtime).

---

## F. SALARY — phức tạp nhất, làm CUỐI (HIGH)

**Wire được (writer có, nhưng lệch ngữ nghĩa — cẩn thận):**

1. `useDeletePayment` `:46-73` → `reverse_invoice_payment_v3`. 🔴 **SEMANTIC INVERT**: writer forward-fix (**GIỮ** payment row + tạo phiếu 'Tiền thối'), legacy hard-delete → **hai đường cho sổ khác nhau**. Chốt authority + sửa `onSuccess` invalidation (payment vẫn còn khi canonical) trước khi bật flag.
2. `useSalaryPayout` nhánh CHI `:822-943` → `salary_payout_v1`. 🔴 Writer **FORCE-APPROVAL** → trả `PENDING_APPROVAL`, **KHÔNG** cộng `salary_monthly.paid`, **KHÔNG** gắn `payout_voucher_id`, **KHÔNG** xử lý gạch nợ tiền phòng. Wire ngây thơ phá flow "trả lương + cấn trừ tiền phòng". Cần: tách nhánh rentInvoice (`:874-937`) → `record_invoice_payment_v4`; dời cập nhật `paid` sang lúc POST; **UI phải hiểu trạng thái chờ duyệt** trước khi bật flag. Sinh idempotency key ổn định `salpay:{staffId}:{periodMonth}:{voucherDate}`.

**Chờ WRITER MỚI (compound multi-table, chưa có test):**
- `lock_salary_month_v1`/unlock (`useLockSalaryMonth`/`useUnlockSalaryMonth` `:650-737`) — gộp approve-commission + upsert LOCKED + snapshot 1 TX.
- `salary_adjustment_upsert_v1`/delete (`:594/601/624` + ensureMonthly `:568`).
- `profit_lock_month_v1`/unlock/resync (`useShareholderProfit.writeLockedMonth` `:364-569`) — tính distributable server-side.
- `profit_manager_save_v1`/delete (`useProfitManagers` `:144-221`, delete-recreate).
- salary config writers (`useSalaryConfig` — `manager_salary_config`/`salary_bonus_rules`/`salary_holidays`) — risk thấp nhưng vẫn direct-DML.

**KHÔNG đụng (đã RPC):** `useCommissionVoucher` (`create_commission_voucher`), toàn bộ `useSalaryV5Admin` (`set_salary_v5_config`/`v5_verdict`/`v5_apply_lock_adjustments`/edge fn). Chỉ regression.

**⚠️ Tenancy mismatch:** config tables keyed `user_id`, writer canonical suy `organization_id` từ toà ảo → chốt mô hình org khớp RLS mới trước khi bọc.

**Browser test:** trả lương KHÔNG/CÓ gạch nợ tiền phòng (canonical PENDING vs legacy immediate) → chốt lương tháng (đóng băng + snapshot + tự duyệt hoa hồng) + mở khoá → xoá payment (forward-fix vs hard-delete, chặn `[HANDOVER_LOCKED]`) → chốt lợi nhuận + resync → commission (chống trùng 23505).

---

## 2. Tóm tắt "làm được gì NGAY" vs "phải viết writer"

**Wire được NGAY bằng adapter-fallback (writer sẵn sàng — chỉ chờ owner re-grant+flag để test canonical):**
- meter CRUD (đã LIVE thật) + **fix bug import** (không cần writer)
- cashbook: create / lock / unlock / archive (4 op)
- income-expense: create phiếu đơn non-recurring (builder đã có)
- contract: renew / transfer-room / transfer-contract / terminate ×2 (legacy làm fallback — chỉ cần viết v1)
- salary: `useDeletePayment`→reverse_v3 (cẩn thận semantic)

**PHẢI viết writer MỚI trước khi wire (khối lượng chính):**
- invoice: **9 state-machine writer** + `create_invoice_v1_v2` parity-extension + `update_invoice_v1`
- income-expense: update / cancel(+payment-reversal) / batch / profit / manager-salary / recurring
- cashbook: `update_cashbook_metadata_v1` + `set_cashbook_shared_users_v1` (+UI opening-balance-adjust)
- contract: 5 ops-v1 + create_contract_v2 + register/delete/update/sync
- salary: lock/unlock lương + profit lock/unlock/resync + profit-manager + adjustment + config

**Chốt với owner trước khi chạy (blocking decisions):**
1. Re-grant + bật flag org canary từng slice (không tự grant — CLAUDE.md authz exception).
2. meter `create_meter_reading_v1` tự-duyệt APPROVED — đúng nghiệp vụ?
3. Model cọc đích (holds vs income_expenses vs deposits).
4. Authority của reverse-payment (forward-fix vs hard-delete) — ảnh hưởng income-expense + salary + contract-terminate.
5. Mô hình org cho salary/cashbook config tables (đang keyed user_id).

**Ràng buộc:** chỉ commit branch `security/authz-preparation`, test trên DB disposable/restore, KHÔNG prod tới khi owner authorize từng slice.


---

# Phụ lục — spec chi tiết từng domain

## invoice (Hoá đơn) — create / update / approve / unapprove / cancel / restore / soft-delete / bulk / overdue-sweep / note + first-month auto-invoice + meter→invoice
- difficulty: **HIGH**
- writers THIẾU (12): approve_invoice_v1, unapprove_invoice_v1, cancel_invoice_v1, restore_invoice_v1, delete_invoice_v1, bulk_approve_invoices_v1, bulk_delete_invoices_v1, update_invoice_v1, check_overdue_invoices_v1, update_invoice_note_v1, create_invoice_v1 PARITY EXTENSION, meter-reading + invoice atomic
- risks: 1) SILENT DATA LOSS (highest): existing create_invoice_v1 is NOT payload-parity — it drops notes, discount_notes, prepaid_amount, previous_debt_sources, template_id, electricity_prev_overridden and ALL per-item extras (service_id, coefficient, previous_reading, current_reading, from_date, to_date). Wiring create/first-invoice as-is breaks meter-based line items, prorated rent-period UI (useInvoiceRentPeriods), and first-month detection (useFirstInvoiceDetails relies on notes text + RENT from_date). MUST extend writer first. Verified by reading t5_02 fn body + prod column defaults. 2) applied_credit consumption (excess_amounts insert) is a sibling write not in any writer — must be folded into the extended create writer for atomicity, else credit can be spent without invoice or vice-versa. 3) create_contract_v1 first-invoice hardcodes discount=0 (t5_05 line 266) — first-month discount lost. 4) useCheckOverdueInvoices runs UNSCOPED on every page load — the writer must be org/building-scoped and idempotent-cheap or it becomes a hot cross-tenant sweep. 5) 9 state-machine writers are genuinely MISSING (confirmed via pg_proc) — bulk of the work is authoring+testing them, though each is a simple guarded UPDATE. 6) restore_invoice_v1 must re-assert the partial-unique period constraint or restore can violate one-invoice-per-contract-per-period. 7) invoice_number/org are trigger-filled — safe to omit in writer, but client-side generateInvoiceNumber becomes dead/racy and should be dropped when wiring create.
- wiring: Adapter pattern per payment reference (src/lib/paymentRecordRpc.ts): build exact RPC args in a pure src/lib/invoiceWriterRpc.ts, call canonical v_next first, fallback to legacy direct-DML only on classify signals PGRST202 (writer-not-deployed) / 55000 'chưa bật' (disabled) / 42501 (v-denied, coexistence). Order:

STATE-MACHINE (simplest, do FIRST — direct 1:1 UPDATE→RPC, no payload gap):
- useApproveInvoice(937) → approve_invoice_v1, fallback current UPDATE.eq(status,DRAFT).
- useUnapproveInvoice(987) → unapprove_invoice_v1, fallback UPDATE.eq(status,APPROVED).
- useCancelInvoice(1539) → cance

## income-expense (Thu-chi)
- difficulty: **HIGH**
- writers THIẾU (7): update_income_expense_v1, cancel_income_expense_v1, create_income_expense_batch_v1, create_profit_distribution_v1, create_manager_salary_payout_v1, update_batch_account_v1, create_income_expense_recurring_v2
- risks: 1. WRITER THIẾU NHIỀU: chỉ 1/8 create-path (phiếu đơn non-recurring) có canonical writer; 5-7 writer phải VIẾT MỚI trước khi wire (update, cancel, batch-create, profit, manager-salary). Payment domain chỉ cần 1 writer — income-expense phức tạp gấp nhiều lần.
2. CROSS-DOMAIN CASCADE (nguy hiểm nhất): useCancelIncomeExpense/Batch xoá thẳng bảng `payments` (statusMutations.ts:88, batch.ts:251). Payment ĐÃ cutover → cancel writer canonical PHẢI gọi payment reversal writer (reverse_invoice_payment_v3/v4), tuyệt đối không raw DELETE, kẻo bypass ledger + lệch invoice paid_amount/status. Rủi ro double-handling cao.
3. RECURRING GAP: create_income_expense_v1 CHẶN recurring (builder throw). Nhánh tạo phiếu lặp (mutations.ts:47-58) không có canonical writer → hoặc mở rộng v1 nhận repeat_*, hoặc viết recurring_v2, nếu không sẽ mãi kẹt legacy.
4. MIS-MAP salary_payout_v1: signature staff-payroll (p_staff_id/p_period_month/p_take_home), KHÔNG phải writer cho useCreateManagerSalaryPayout (profit_manager_id, 'Lương điều hành'). Nếu wire nhầm sẽ ghi sai bảng/sai loại phiếu. Cần writer riêng.
5. GRANT GATE: create_income_expense_v1 & salary_payout_v1 hiện chỉ GRANT postgres (revoked authenticated) — chưa thể test end-to-end trên browser cho tới khi owner re-grant + bật flag org canary. Không tự grant (CLAUDE.md authz exception).
6. ATOMICITY: batch-create hiện rollback best-effort ở client (soft-delete + delete batch) — dễ để lại phiếu con mồ côi khi lỗi giữa chừng. Writer mới phải làm trong 1 TX.
7. Adapter builder đã có nhưng CHƯA WIRE (chỉ dùng trong test) — cần thêm lớp routing + telemetry mismatch như payment.
- wiring: MẪU: bám adapter v4-fallback của payment (src/lib/paymentRecordRpc.ts): build args thuần (không route) → gọi canonical trước → classify lỗi (PGRST202 not-deployed / 55000 'chưa bật' disabled / 42501 v4-denied) → fallback legacy; 23505 KHÔNG BAO GIỜ fallback.

PRECONDITION (gate owner): create_income_expense_v1 và salary_payout_v1 hiện chỉ GRANT cho postgres (đã revoked khỏi authenticated sau revert) — KHÔNG thể wire/test cho tới khi owner re-grant + bật flag cho org canary. Đối chiếu: record_invoice_payment_v4 (reference) đang GRANT authenticated = live. Đến khi re-grant, adapter luôn nhận 425

## cashbook (Sổ quỹ — public.accounts + account_shared_users; ledger side income_expenses)
- difficulty: **HIGH**
- writers THIẾU (3): update_cashbook_metadata_v1, set_cashbook_shared_users_v1, NOTE
- risks: HIGH complexity concentrated in useUpdateAccount and shared-users: (1) TWO writers missing — update_cashbook_metadata_v1 and a share/custody writer — both confirmed absent in pg_proc; create+lock+archive can wire now but metadata/share cannot. (2) Opening-balance semantics INVERT: today initial_amount is a raw editable field on the update path; canonical model forbids overwrite and demands a forward-fix compensating income_expense via request_opening_balance_adjustment_v1 (which has NO current call-site). Wiring this needs new UI (delta+reason capture) — silent behavior change for users who currently just edit the number. (3) create_cashbook_v1 DROPS fields the form sends: description lost, is_default forced false, admin-set user_id (owner) ignored (writer forces auth.uid()) — parity regressions unless writer is extended or form constrained. (4) create requires idempotency_key the frontend must now mint; returns {cashbook_id} not the full row (CashbookForm.tsx:141 depends on created.id). (5) archive_cashbook_v1 refuses non-empty cashbooks while current delete allows soft-delete regardless — user-visible refusal. (6) lock is now monotonic (cannot move earlier) — previously free-form. (7) org derivation in create_cashbook_v1 fails closed if the actor has >1 ACTIVE membership ('không xác định được tổ chức duy nhất'); multi-org admins would be blocked. (8) accounts_org_boundary RESTRICTIVE (t6a) already live — organization_id must be set (writer derives it; direct-DML create currently does NOT set it, so canonical create actually FIXES a latent gap). Browser-test needed across create / rename / opening-balance-adjust / lock+unlock / archive-empty vs archive-with-vouchers / share-user sync — but per CLAUDE.md authz exception, test on disposable/restored DB, NOT production, until owner authorizes the slice.
- wiring: Adapter v4-fallback pattern (per src/lib/paymentRecordRpc.ts): each adapter calls canonical RPC first; on route-not-enabled (55000 'chưa bật'), EXECUTE-denied (42501/permission), or function-missing → fall back to current direct DML. Per write-site:

1) useAccounts.ts:176 useCreateAccount → create_cashbook_v1. GAP: writer sig has p_bank_name/p_account_number (frontend create does NOT send — pass null, OK) but writer DROPS description, ignores is_default (forces false), and IGNORES caller user_id (forces owner=auth.uid() — admin-creates-for-another-user is lost). Writer also REQUIRES p_idempote

## meter (ghi chỉ số công tơ + sinh hoá đơn atomic)
- difficulty: **HIGH**
- writers THIẾU (4): create_invoice_with_reading_v1, unapprove_meter_reading_v1, approve_meter_reading_v1, bulk_approve_meter_readings_v1
- risks: 1) CRUD reading LÀNH: 5 writer v1 LIVE (authenticated=t), signature khớp payload 1:1 — rủi ro thấp, không cần fallback. Đây là điểm khác biệt lớn so với payment (payment bị revoke). 2) create_meter_reading_v1 ép status='APPROVED' + approved_by=caller: NGƯỢC docstring hook (ghi 'UNAPPROVED') và ngược ý định UI 'ghi chỉ số chờ duyệt' — kiểm lại business: nếu nhánh /meter-readings kỳ vọng reading mới ở trạng thái UNAPPROVED thì writer đang tự-duyệt SAI. Cần xác nhận với owner trước khi coi CRUD là 'xong'. 3) Import Excel (:359) ĐANG HỎNG runtime do truyền p_user_id vào function chỉ có (p_readings jsonb) — cần browser-test xác nhận và vá. 4) Unapprove là direct-DML thuần, không RLS-safe theo chuẩn authz — hở tenant nếu RLS lỏng. 5) ATOMIC writer là cross-domain (reading+invoice+items+excess_amounts): độ khó cao, KHÔNG thể cutover độc lập khỏi invoice-domain (create_invoice_v1 đang revoked + frontend chưa gọi). Nếu chỉ route nửa reading qua v1 mà invoice vẫn direct-DML thì VẪN non-atomic — không giải quyết gap. 6) prev_reading override (electricity_prev_overridden) trong dialog vs trigger auto_populate_previous_reading có thể lệch — writer atomic phải nhận prev_reading tường minh, không để trigger đè. 7) Trùng tên useBulkCreateMeterReadings ở 2 module dễ wire nhầm — xoá bản dead ở useInvoices trước.
- wiring: TRẠNG THÁI: CRUD reading ĐÃ hard-cutover sang v1 và writers LIVE (authenticated=t) — không phải revoked như payment. KHÔNG cần adapter v4-fallback cho 5 site CRUD; chúng chạy được ngay. Việc còn lại là 4 nhóm gap.

(1) Import Excel — useMeterReadings.ts:359: SỬA NGAY (bug độc lập, không cần writer mới). Rewire useImportMeterReadings → bulk_create_meter_readings_v1(p_readings jsonb) [bỏ p_user_id, bỏ JSON.stringify — truyền array trực tiếp], map {meter_code→meter_id?}. Lưu ý: v1 nhận meter_id, còn import nhận meter_code → cần resolve meter_code→meter_id ở client hoặc viết bulk_import_meter_read

## deposit-contract (Cọc giữ chỗ + Hợp đồng: tạo/cập nhật/gia hạn/chuyển phòng/nhượng/đăng ký chuyển đi/thanh lý/xoá)
- difficulty: **HIGH**
- writers THIẾU (11): renew_contract_v1, transfer_room_v1, transfer_contract_v1, terminate_contract_forfeit_v1, terminate_contract_move_out_v1, update_contract_v1, sync_contract_customers_v1 + sync_contract_services_v1, delete_contract_v1, register_move_out_v1, create_contract_v1 CẦN MỞ RỘNG SIGNATURE, deposit writers
- risks: 1) create_contract_v1 signature THIẾU ~12 field (payment_cycle, start/end_billing_date, templates, notes, discounts, deposit_debt_*, deposit_paid, per-customer is_representative, per-service initial_reading, firstInvoiceDiscount) → wire as-is REGRESS tạo HĐ (mất chu kỳ thu, kỳ tính tiền, mẫu HĐ/HĐ, khuyến mãi, nợ cọc). PHẢI mở rộng v2 trước.
2) Xung đột MÔ HÌNH cọc giữ chỗ: 3 đường song song — room_reservation_holds (canonical writer), income_expenses is_deposit voucher (QuickDepositModal/useContractSubmit, mô hình THỰC), bảng deposits (useCreateDeposit/ConvertLead). Wire nhầm → double-count cọc hoặc mất trạng thái RESERVED/khoá phòng realtime.
3) Non-atomic post-RPC ở client: consumeRemainingCredit INSERT excess_amounts SAU terminate RPC (useContractOperations L200/L330); tạo phiếu thu cọc income_expenses + flip deposits CONVERTED SAU create-contract RPC (useContractSubmit L308/L350). Nếu client crash giữa chừng → credit/cọc/phòng lệch. Canonical writer nên hấp thụ để atomic.
4) create_contract_v1 gọi create_invoice_v1 (coupling domain invoice — HĐ đầu). Bật contract writer cần invoice writer live cùng org; lệch flag → HĐ tạo được nhưng HĐ-đầu route lệch.
5) Legacy renew/transfer/terminate ĐÃ SECURITY DEFINER + can_do_on_building + granted authenticated — dễ nhầm là 'đã canonical'. Chúng KHÔNG có ledger/idempotency → v1 vẫn phải viết mới; nhưng payload legacy khớp frontend 1:1 (verified prod) nên fallback an toàn.
6) Dead hooks (useApproveTermination…) còn raw DML cash_book/contract_terminations — rủi ro bị ai đó wire lại; nên xoá.
7) Reservation writer revoke khỏi authenticated (EXECUTE chỉ postgres) — verify prod: create_contract_v1 & create_reservation_deposit_v1 CHƯA callable từ client, đúng trạng thái flag OFF; adapter phải fallback sạch (PGRST202/42501) tránh vỡ luồng tạo HĐ đang chạy production.
- wiring: THỨ TỰ ưu tiên (áp mẫu adapter v4-fallback: gọi canonical trước, fallback legacy khi PGRST202 writer-not-deployed / 55000 'chưa bật' / 42501 v4-denied; 23505 KHÔNG fallback).

NHÓM 1 — renew/transfer/terminate (dễ nhất, đã có legacy authz-aware làm fallback): (a) VIẾT renew_contract_v1/transfer_room_v1/transfer_contract_v1/terminate_contract_forfeit_v1/terminate_contract_move_out_v1 (ledger op contract.renew.v1/… + idempotency + route + hấp thụ consumeRemainingCredit vào terminate writer). (b) Tạo src/lib/contractOpsRpc.ts kiểu paymentRecordRpc.ts: buildArgs + *WithFallback(v1→legacy). (c) Wir

## salary (Lương / hoa hồng / lợi nhuận cổ đông / lương điều hành / refund-xoá phiếu)
- difficulty: **HIGH**
- writers THIẾU (6): lock_salary_month_v1 / unlock, salary_adjustment_upsert_v1 / delete, salary_payout rent-offset, profit_lock_month_v1 / unlock / resync, profit_manager_save_v1 / delete, salary config writers
- risks: HIGH tổng thể. (1) salary_payout_v1 lệch NGỮ NGHĨA lớn so với frontend: writer là FORCE-APPROVAL → trả PENDING_APPROVAL, KHÔNG cộng salary_monthly.paid, KHÔNG gắn payout_voucher_id, KHÔNG xử lý gạch nợ tiền phòng. Wire ngây thơ sẽ phá flow 'trả lương + cấn trừ tiền phòng' và làm cột 'đã trả' đứng im; cần record_invoice_payment_v4 cho rent-offset + dời cập nhật paid sang lúc POST + UI hiểu trạng thái chờ duyệt. (2) reverse_invoice_payment_v3 đổi hard-delete → compensating refund 'Tiền thối': payment row VẪN tồn tại; UI/hook nào giả định phiếu biến mất (danh sách, tổng thu, handover) sẽ hiển thị khác — phải rà onSuccess invalidation + màn hình phụ thuộc. (3) Nhiều writer THIẾU (lock lương, chốt LN, profit managers, config) → KHÔNG thể cutover trọn domain; các thao tác này là compound multi-table (approve-commission+lock+snapshot; profit distributable) cần viết definer mới cẩn thận, chưa có test. (4) Mismatch multi-tenant: frontend keyed user_id/ownerId, writer suy organization_id từ toà ảo → config tables cần mô hình org rõ trước khi bọc. (5) idempotency_key: frontend phải sinh key ổn định đúng regex, sai key → 23505 (không được fallback). (6) Ràng buộc CLAUDE.md authz: chỉ commit branch preparation, KHÔNG bật flag/canary/route production tới khi có lệnh owner + gate.
- wiring: THỨ TỰ: (1) wire useDeletePayment → reverse_invoice_payment_v3; (2) wire nhánh CHI của useSalaryPayout → salary_payout_v1 (+ record_invoice_payment_v4 cho gạch nợ); (3) VIẾT MỚI các writer lock/profit/config rồi wire.

A) useDeletePayment (L46-73) → reverse_invoice_payment_v3(payment_id, reason, idempotency_key). Adapter theo mẫu paymentRecordRpc.ts: gọi writer v3 canonical trước; classify lỗi PGRST202/55000-'chưa bật'/42501 → fallback legacy direct-DML (4 bước hiện tại) đúng như classifyV4FallbackSignal; 23505 KHÔNG fallback. CẢNH BÁO SEMANTIC: writer forward-fix (giữ payment + phiếu 'Tiền th

