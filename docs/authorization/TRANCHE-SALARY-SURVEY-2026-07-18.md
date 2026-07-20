# Khảo sát domain SALARY (2026-07-18) — chuẩn bị nhịp build

> **Lifecycle:** historical build evidence. Writer salary đã được xây dựng và go-live sau snapshot này; xem [README.md](README.md). File được giữ vì SQL `t5_11` tham chiếu trực tiếp.

Verified prod read-only + code `release/meter-domain`. Trạng thái: **SURVEY xong, chưa build. Có 1 design-fork cần owner quyết (giống income-expense).**

## 0. Ba vùng độ sẵn sàng

- **(A) ĐÃ server-side, không cần đụng:** `create_commission_voucher`; luồng Đóng tiền tập trung (`pay_period_fee`/`get_period_commissions`/`update_period_fee`/`cancel_period_fee`/`pay_draft_fee_voucher`); toàn bộ engine lương v5 (`v5_*`, `set_salary_v5_config`, edge `salary-v5-jobs`). Component salary không có write trực tiếp.
- **(B) Writer có nhưng inert + LỆCH PARITY:** `salary_payout_v1` (flag `salary.payout.v1`=OFF, chưa grant authenticated — inert kép).
- **(C) CHƯA có writer:** lock/unlock tháng, payout quản lý điều hành (profit), adjustments, config/bonus-rules/holidays.

## 1. Write-sites client còn trần

| Hook | Đụng | Cascade tiền? | Ưu tiên |
|---|---|---|---|
| **`useSalaryPayout`** (useManagerSalary.ts:769) | insert income_expenses(EXPENSE)+items; nếu gạch nợ tiền phòng: insert payments(CT) + income_expenses(INCOME)+items; update salary_monthly(paid, payout_voucher_id) | **NGUY HIỂM NHẤT** — cascade 5-6 bước client không atomic, 3 bảng tiền, bypass IE-create + payment-writer + a00_payment_canonical_link_guard. Đứt giữa chừng: payment mồ côi / hoá đơn ĐÃ-THU thiếu phiếu đối ứng / lệch paid | **P1** |
| **`useLockSalaryMonth`** (:635) | bulk **raw UPDATE income_expenses.approval_status='APPROVED'** (phiếu hoa hồng) + upsert salary_monthly(LOCKED) + snapshot ledger | Duyệt loạt phiếu CHI bằng raw UPDATE, bỏ qua approve_income_expense_v1/approve_voucher; không atomic. **Vỡ tiềm tàng khi commission lên canonical (freeze 55000)** | **P1/P2** |
| `useCreateManagerSalaryPayout` (specialized.ts:126) | insert income_expenses(EXPENSE, profit_manager_id)+items | 1 phiếu chi, bypass IE-create; đường profit riêng | **P2** |
| `useUnlockSalaryMonth` (:725) | delete snapshot + salary_monthly→DRAFT | Không tiền; KHÔNG hoàn tác duyệt hoa hồng lúc lock (bất đối xứng) | **P2** (gộp lock) |
| `useSaveSalaryAdjustment`/`useDeleteSalaryAdjustment` (:586/:620) | salary_adjustments + ensureMonthly | Không tiền mặt | P3 |
| `useSaveManagerConfig`/`useSaveBonusRules`/`useAddHoliday`… (useSalaryConfig.ts) | config thuần | — | P3 |

Scope note: `useShareholderProfit.ts` (lock/unlock profit tháng, allocations) = domain **profit-distribution** kề bên (quyền `shareholder_profit.distribute`) — khảo sát tranche riêng.

## 2. Có sẵn trên prod (verified)

- **`salary_payout_v1(p_staff_id, p_period_month, p_take_home, p_account_id, p_voucher_date, p_note, p_idempotency_key)`** — thế hệ org-model: `authorize_tenant_action_v3(…'salary.distribute'…)` + `lock_org_for_decision_v1` + ledger idempotency + **`submit_financial_request_v1`** → phiếu EXPENSE UNAPPROVED, trả `state:'PENDING_APPROVAL'`. **Thiếu:** gạch nợ tiền phòng; không update salary_monthly.paid ngay; không phục vụ profit_manager_id.
- **Permission catalog ĐẦY ĐỦ, active, gán role CẢ 2 ORG:** salary.distribute/lock/unlock/manage_salary (ELEVATED), salary.export, salary.view, shareholder_profit.distribute. → tốt hơn IE.
- **Approval rule-set ACTIVE cả 2 org**; `submit_financial_request_v1` sẵn.
- Flags: `salary.payout.v1`=OFF (income_expense.create_draft.v1=CANARY, invoice.record_payment.v1=ON…).

## 3. Ground truth khác

- Population TÍ HON: salary_monthly=2, manager_salary_config=2 (đều của super-admin) → blast-radius nhỏ, canary demo dễ.
- Bảng salary_* chỉ có trigger updated_at (không freeze/guard) — tiền thật nằm ở income_expenses/payments (đã có guard canonical).
- RLS salary: `*_owner_all` + `*_self_select`; salary_monthly/manager_salary_config scope theo user_id (legacy), KHÔNG org-scoped.
- Coexistence: 68 phiếu hoa hồng chưa flow-owned → raw bulk-approve của lock còn chạy hôm nay, nhưng sẽ vỡ khi commission lên canonical.

## 4. Writer cần viết/vá

1. **`salary_payout_v1` — LỆCH PARITY, FORK cần owner:** payout có đi qua engine duyệt cưỡng bức (PENDING_APPROVAL) hay "chi & ghi paid ngay" như UX hiện tại? Rent-offset: (A) mở rộng in-writer (`p_rent_invoice_id`, `p_rent_amount` → gọi record_invoice_payment_v3/v4 + create_income_expense_v1 atomic) vs (B) companion `salary_payout_rent_offset_v1`. Quyền: `salary.distribute`.
2. **`lock_salary_month_v1` (MỚI)** — atomic: duyệt hoa hồng QUA approve_income_expense_v1/approve_voucher (bỏ raw UPDATE) + upsert LOCKED + snapshot; guard DRAFT→LOCKED; quyền `salary.lock`. Companion `unlock_salary_month_v1` (quyền `salary.unlock`; quyết có hoàn tác duyệt HH không).
3. **`manager_salary_payout_v1`** (đường profit) — quyền `shareholder_profit.distribute` (hoặc gộp vào payout bằng p_manager_kind).
4. (P3) writers adjustments/config — quyền `salary.manage_salary`; có thể để legacy sau cùng.

## 5. Thứ tự nhịp build

1. **[GATE 0]** Audit parity salary.distribute/lock/unlock cho actor thật (IE đã chứng minh authority-graph hẹp hơn RLS) → materialize trước canary real-org.
2. **[OWNER]** Chốt fork payout (engine-duyệt vs immediate; rent-offset A vs B) — **DESIGN-BLOCKED tại đây**.
3. **[BUILD]** lock/unlock_salary_month_v1 → wire + fallback, flag OFF.
4. **[BUILD]** vá salary_payout_v1 theo fork → wire useSalaryPayout.
5. **[BUILD]** manager_salary_payout_v1 + P3.
6. **[VERIFY]** disposable → canary demo (population=2) → real-org sau GATE 0. Hiện tại an toàn: flag OFF + chưa grant → app 100% legacy.

**So sánh:** salary giống IE (phải author + có fork), thuận lợi hơn ở permission catalog + rule-set đủ cả 2 org và population nhỏ.
