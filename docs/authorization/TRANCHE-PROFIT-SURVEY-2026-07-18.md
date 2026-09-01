# Khảo sát domain PROFIT-DISTRIBUTION (2026-07-18)

> **[LỊCH SỬ — ĐÃ SHIP 19/07/2026]** Bằng chứng go-live phân quyền v3. Hiện hành: `../he-thong/01-phan-quyen-nhan-su.md` + `README.md` cùng thư mục. Giữ làm bằng chứng, không cập nhật nữa.

> **Lifecycle:** historical build evidence. Writer profit đã được xây dựng và go-live sau snapshot này; xem [README.md](README.md). File được giữ vì SQL chuẩn bị dùng nó làm nền thiết kế.

Verified prod read-only + code. **SURVEY xong — domain "trần" nhất: CHƯA có writer/flag nào. 2 design-fork cần owner.** Kề salary (TRANCHE-SALARY-SURVEY), dùng chung nền org-decision.

## Write-sites client còn trần

| Hook | Đụng | Tiền? | Ưu tiên |
|---|---|---|---|
| **`useCreateProfitDistribution`** (specialized.ts:10) | insert income_expenses(EXPENSE, shareholder_id, KQKD=false, toà ảo)+item; có thể insert type | **TIỀN THẬT — APPROVED NGAY** (default), **KHÔNG idempotency → double-submit = double phiếu chi cổ đông** | **P1** |
| **`useCreateManagerSalaryPayout`** (specialized.ts:126) | y hệt, đường profit_manager_id | Cùng rủi ro | **P1** |
| `useLockProfitMonth`→writeLockedMonth (useShareholderProfit.ts:462/:340) | upsert profit_monthly(LOCKED, management_salary) + delete&insert profit_allocations + profit_manager_allocations | KHÔNG tiền, nhưng đa bảng non-atomic; **làm tròn + tính distributable NGAY TRÊN CLIENT** | **P2** |
| `useResyncLockedMonths` (:483) | loop writeLockedMonth × N tháng | ghi đè không hoàn tác | P2 (gộp) |
| `useUnlockProfitMonth` (:554) | delete 2 bảng allocation + profit_monthly→DRAFT | 3-step non-atomic | P2 (gộp) |
| `useSaveManagerWithSalaries` / `useDeleteProfitManager` (useProfitManagers.ts) | config | — | P3 |

UI: 2 dialog chi tiền nhập số TỰ DO (không kéo từ snapshot allocation) — cash-out tách rời allocation.

## Prod facts

- **KHÔNG có** fn `%profit%` writer, không flag `profit%`, không prepared SQL. Nền org-decision đủ: `authorize_tenant_action_v3` + `submit_financial_request_v1` + `lock_org_for_decision_v1`.
- `create_income_expense_v1` **KHÔNG phủ** phiếu profit (thiếu p_shareholder_id/p_profit_manager_id) → phải viết writer chuyên biệt.
- **Permission catalog đủ, ALLOW cả 2 org**: shareholder_profit.distribute/lock/unlock/manage_shareholders/view/export. **Thiếu duy nhất** perm riêng cho chi lương quản lý (fork B).
- Population: profit_monthly=35 (toàn LOCKED), allocations=49/7, managers=1. **Phiếu chi cổ đông/quản lý = 0** → money-path CHƯA TỪNG chạy ⇒ canary money rủi ro ~0. Lock-path đang sống (touch 2026-07-05).
- Bảng profit_* = bookkeeping thuần (chỉ trigger updated_at, không guard); RLS `*_owner_all` user_id-scope (KHÔNG org) + `*_self_select`.
- **⚠️ LATENT BUG org-NULL:** profit_* KHÔNG có `_autofill_org`, organization_id nullable, `writeLockedMonth` không set org ⇒ **khoá THÁNG MỚI sẽ ghi organization_id=NULL** (rơi ngoài RLS/report org-scope). Hiện 0 row null chỉ vì hoạt động gần đây là re-lock (upsert UPDATE giữ org cũ). Writer server-side stamp org sẽ vá đúng chỗ.

## Writer cần viết (toàn bộ MỚI)

1. `lock_profit_month_v1(p_period_month, p_rows jsonb, p_idempotency_key)` — atomic, tính+làm tròn server-side, stamp org; quyền `shareholder_profit.lock` (authorize_tenant_action_v3, scope ORG). Companion `unlock_profit_month_v1`. Resync = loop lock_v1.
2. `distribute_shareholder_profit_v1(p_shareholder_id, p_amount, p_account_id, p_voucher_date, p_note, p_idempotency_key)` — quyền `shareholder_profit.distribute`; nội tại resolve toà ảo + type; idempotency vá double-submit.
3. `manager_salary_payout_v1(...)` — sinh đôi #2 với profit_manager_id. **Fork B quyền**: (a) reuse shareholder_profit.distribute / (b) salary.distribute / (c) perm mới `shareholder_profit.pay_manager`. Hoặc gộp #2+#3 bằng p_subject_kind.
4. (P3) config writers — quyền manage_shareholders.

## 2 FORK cần owner (DESIGN-BLOCKED)

- **A (giống salary):** phiếu chi cổ đông/quản lý **APPROVED-ngay** (đúng UX hiện tại) hay **ép qua submit_financial_request_v1 → PENDING_APPROVAL**?
- **B:** quyền cho manager-payout (3 lựa chọn trên).

## Thứ tự build

GATE 0 parity (như IE/salary) → owner chốt fork A+B → build lock/unlock trước (không tiền, vá org-NULL, flag `shareholder_profit.lock.v1`=OFF) → build 2 money-writer (flag OFF) → P3 → disposable → canary demo → real-org. An toàn hiện tại: chưa có writer/flag ⇒ app 100% legacy.
