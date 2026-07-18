# Trạng thái sau khi chốt D1–D4 (2026-07-19)

Toàn bộ 4 quyết định owner đã THỰC HIỆN + verified. App an toàn: mọi writer tiền
đang inert (flag OFF) trừ IE-create real-org (canary có chủ đích). Tiền real-org
bất biến `3.891.819.563` (= baseline + giao dịch JOEY).

## Đã xong + verified

| Quyết định | Làm gì | Bằng chứng |
|---|---|---|
| **D1a** người duyệt = "Chủ sở hữu tổ chức" | t5_17 gán approver ROLE cả 2 org | E2E demo: chunha lập→PENDING→quanly duyệt→POSTED+APPROVED |
| **D1b** tự gạch "đã trả" | t5_19 trigger accrual paid+payout_voucher_id | Test 2 chiều: duyệt→paid+5tr, bỏ duyệt→trừ lại |
| **D2b** chốt lương chặt | t5_11 2 guard: (1) lợi nhuận tháng phải chốt trước; (2) liệt kê phiếu HH thiếu sổ quỹ | REST: happy 200, guard1/guard2 chặn đúng, org subject-derived (đa tenant) |
| **D3** huỷ HĐ khi sạch phiếu thu | t5_18 force_cancel_v2 (KHÔNG xoá payment) | REST: còn 6 phiếu thu→chặn; đã huỷ→no-op |
| **D4** máy tạo HĐ đủ 7 ô + credit | t5_14 create/update_invoice_v1 parity | REST: 7 field + credit −50k + số HĐ trigger + assert lệch total chặn; call-compat create_contract_v1 verified |

Wire hook + push main (release/meter-domain → main) + security branch đầy đủ.

## Trạng thái flag (an toàn)

- **income_expense.create_draft.v1 = CANARY** (real+demo) — hoạt động thật, cửa 72h.
- invoice.record_payment.v1 = ON (đã live từ trước, JOEY dùng).
- Còn lại OFF (inert, fallback legacy): invoice.create.v1, salary.lock/unlock.v1,
  salary.payout.v1, shareholder_profit.distribute/pay_manager.v1.

## GATE-0 real-org đã mở cho payout family

- Grant v3 `income_expenses.approve` cho role "Quản Lý Tòa" org thật + bind
  joey/nathan (khớp thẩm quyền legacy) → phiếu do chủ lập có người duyệt.
- Verify: nathan + nguyen resolve approve qua v3.

## Việc kích hoạt còn lại (mỗi cái là 1 bước bật cờ có chủ đích — KHÔNG cần code thêm)

Tất cả writer đã sẵn + verified. Bật = set flag CANARY per-org + theo dõi:
1. **salary.lock/unlock** → canary real-org (chốt lương tháng qua guard).
2. **salary.payout** (t5_12 rent-offset) — CHỜ APPLY t5_12 (draft, chưa apply) + engine accrual đã sẵn.
3. **shareholder_profit.distribute/pay_manager** → canary (engine duyệt đã chạy E2E).
4. **invoice.create** → canary (parity verified).

Khuyến nghị: bật lần lượt, mỗi domain theo dõi 1 chu kỳ trước khi mở rộng — như đã làm với payment/IE.
