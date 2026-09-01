# FINDING: đường "payout qua engine duyệt" chưa sẵn sàng (2026-07-18)

> **[LỊCH SỬ — ĐÃ SHIP 19/07/2026]** Bằng chứng go-live phân quyền v3. Hiện hành: `../he-thong/01-phan-quyen-nhan-su.md` + `README.md` cùng thư mục. Giữ làm bằng chứng, không cập nhật nữa.

> **Lifecycle:** historical audit evidence. Blocker này đã được xử lý trước go-live; trạng thái hiện hành nằm ở [README.md](README.md) và [STATUS-2026-07-19-GOLIVE-FULL.md](STATUS-2026-07-19-GOLIVE-FULL.md). Nội dung bên dưới giữ nguyên để giải thích vì sao các migration `t5_17`–`t5_19` tồn tại.

**Mức độ: BLOCKER cho cả họ money-payout** (salary_payout_v1, distribute_shareholder_profit_v1,
manager_salary_payout_v1). Không phá gì hiện tại — tất cả đang **inert (flag OFF)**, app 100% legacy.

## Bối cảnh

Owner chốt fork: phiếu chi lương/cổ đông/quản lý **đi qua `submit_financial_request_v1`
→ PENDING_APPROVAL** (không chi-approved-ngay). 3 writer đã build theo hướng này
(`salary_payout_v1` có sẵn; `distribute_shareholder_profit_v1` + `manager_salary_payout_v1`
= t5_13 APPLIED inert). Khi **test thật** distribute trên demo (chunha, có quyền qua
authorize_tenant_action_v3 ROLE_ALLOW), writer chạy đúng tới bước submit rồi **fail-closed**:

```
55000: step <uuid> has zero eligible candidates
```

## 2 blocker thật (đều là hạ tầng, KHÔNG phải bug writer)

### Blocker 1 — Rule-set approval KHÔNG có eligible approver
`FINANCIAL_VOUCHER` rule-set ACTIVE trên demo (và cần verify real-org) có bước duyệt
nhưng **không principal nào eligible** làm approver cho bước đó → `submit_financial_request_v1`
raise, cả transaction rollback (verify: 0 phiếu, 0 op để lại — writer atomic, fail-closed
đúng thiết kế: **không bao giờ post tiền khi thiếu người duyệt**).

⇒ Cần **cấu hình approver** cho rule-set (approval_rules/approval_rule_steps/
approval_step_approvers) — ai được duyệt phiếu chi lương/cổ đông, maker-checker thế nào.
Đây là **quyết định nghiệp vụ + config**, không improvise được.

### Blocker 2 — Không có cơ chế stamp `salary_monthly.paid` / `payout_voucher_id` khi POST
Xác nhận qua dump: `post_financial_request_v1` chỉ chuyển `income_expenses→APPROVED` +
`approval_requests→POSTED`, **KHÔNG đụng salary_monthly**. Không code nào ghi
`payout_voucher_id` (`pg_proc` grep = 0). ⇒ Vòng kế toán "đã chi lương → đánh dấu paid"
**chưa khép**. Đây là **khe hở sẵn có** của `salary_payout_v1` (không phải do writer mới).

⇒ Owner chọn cơ chế accrual: (a) trigger trên `income_expenses` khi salary-voucher→APPROVED
stamp paid, (b) mở rộng `post_financial_request_v1`, hay (c) tính `paid` qua VIEW.

## Trạng thái đã set (an toàn)

- t5_13 (distribute/pay_manager) + permission `shareholder_profit.pay_manager` (v3 ROLE_ALLOW
  reachable — verified chunha=t/t) APPLIED. **Flag OFF** → inert.
- Toà ảo "Chung (Demo)" đã seed cho org dddd (TR-2 — fixture hợp lệ, real-org đã có sẵn).
- salary drafts t5_11 (lock/unlock) + t5_12 (payout extend) sẵn sàng — **CHƯA apply** (payout
  phụ thuộc cùng engine → chờ 2 blocker; lock/unlock KHÔNG phụ thuộc engine → apply được ngay).

## Việc CẦN owner/design (gom lại)

1. **Cấu hình approver** cho rule-set FINANCIAL_VOUCHER (cả 2 org): ai duyệt phiếu chi
   lương/cổ đông/quản lý. Không có → toàn bộ payout-qua-engine fail-closed.
2. **Cơ chế accrual paid** (a/b/c trên).
3. GATE-0 parity real-org cho salary.lock/unlock/distribute + shareholder_profit.* (như IE).

## Việc build tiếp KHÔNG bị chặn (đang/ tiếp)

- **Profit lock/unlock** (t5_16) — ĐÃ ship, không đụng engine.
- **Salary lock/unlock** (t5_11) — apply được ngay (duyệt HH qua approve_income_expense_v1/
  approve_voucher, không qua submit-engine).
- **Invoice nhịp 2**: create-parity (t5_14, auto-approve server) + force-cancel-v2 (t5_15,
  compensating reversal qua reverse_invoice_payment_v3 — đã proven bởi JOEY txn) — không đụng engine.
- Wire profit-money hooks với fallback (flag OFF → "chưa bật" → legacy) — code ready, inert.
