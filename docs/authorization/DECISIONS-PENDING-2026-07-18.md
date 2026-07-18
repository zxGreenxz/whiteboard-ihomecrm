# Quyết định đang chờ owner (2026-07-18) — gom 1 chỗ để mở nốt phần còn lại

Mọi hạng mục dưới đây **đã build/khảo sát xong về kỹ thuật**, đang **an toàn (inert/legacy)**,
chỉ chờ 1 quyết định nghiệp vụ để kích hoạt/hoàn tất. App hiện chạy 100% như cũ.

## Đã LIVE + verified hôm nay (không chờ gì)
- **IE-create canonical org THẬT** (canary 72h) · **Chốt/mở-khoá lợi nhuận tháng** (t5_16, vá bug org-NULL) · **Thanh lý HĐ** (t5_10) · payment/meter/cashbook/IE-demo (trước đó).

## Quyết định cần chốt

### D1 — Máy duyệt cho họ "chi lương / chia cổ đông" (BLOCKER lớn nhất)
Fork anh đã chọn = chi qua bước duyệt. Nhưng hạ tầng duyệt thiếu 2 thứ:
- **D1a. Ai được duyệt** phiếu chi lương/cổ đông/quản lý? (rule-set FINANCIAL_VOUCHER
  hiện KHÔNG có approver hợp lệ → phiếu fail-closed, không chi được). Cần: chủ nhà?
  kế toán trưởng? cần mấy chữ ký?
- **D1b. Đánh dấu "đã chi" (paid) thế nào** sau khi duyệt? Khuyến nghị: trigger tự
  stamp `paid`+`payout_voucher_id` khi phiếu lương → APPROVED.
→ Mở được: `distribute_shareholder_profit_v1`, `manager_salary_payout_v1` (đã applied inert),
  `salary_payout_v1` (+rent-offset t5_12 draft).

### D2 — Chốt lương tháng: phiếu hoa hồng KHÔNG có sổ quỹ (parity thật)
Org thật có **3/8 phiếu hoa hồng UNAPPROVED thiếu sổ quỹ**. Legacy "chốt lương" duyệt
chúng bằng raw-UPDATE (bỏ qua kiểm sổ quỹ). Writer canonical duyệt qua hàm chuẩn →
ĐÒI sổ quỹ → **sẽ làm chốt-lương-tháng FAIL** cho tháng chứa các phiếu đó. Chọn:
- **(a)** giữ raw-UPDATE-có-guard cho duyệt hoa hồng khi chốt (không route qua approve) —
  giữ nguyên hành vi, khuyến nghị;
- **(b)** bắt buộc gán sổ quỹ trước khi chốt (đổi thói quen, chặt hơn).
→ Mở được: `lock/unlock_salary_month_v1` (t5_11 draft).

### D3 — Force-cancel hoá đơn (super-admin xoá HĐ mọi trạng thái)
Bản v2 "hoàn tiền compensating giữ lịch sử" (anh chọn) khi dùng `reverse_invoice_payment_v3`
bị chặn 2 chỗ: flag reverse OFF + hàm đòi quyền `thu_tien.undo` trên actor (super-admin
cross-org không qua). Chọn:
- **(a)** bản INLINE (tự hoàn tiền trong writer, gate `is_super_admin`, KHÔNG phụ thuộc
  flag/authz reverse) — khuyến nghị, ship được ngay;
- **(b)** bật flag reverse + nới authz cho super-admin (đụng nhiều hơn).
→ Mở được: `super_admin_force_cancel_invoice_v2` (t5_15 draft) — bỏ hard-delete payments.

### D4 — Tạo/sửa hoá đơn canonical (parity)
`create_invoice_v1` hiện bỏ 7 field + bước tiêu credit → phải DROP+recreate parity
(t5_14 draft). Rủi ro: `create_contract_v1` GỌI `create_invoice_v1` (13 arg) → phải
verify call-compat trước khi apply (cả 2 flag OFF, dormant → không gấp). Chọn:
- **(a)** apply dormant + test kỹ call-compat rồi wire fallback (an toàn, khuyến nghị);
- **(b)** để nguyên tới khi cần bật invoice-create canonical.
Phụ: `p_creator_name` giữ/bỏ (D4-phụ, nhỏ).

### D5 — GATE-0 parity real-org cho salary/profit (như đã làm cho IE)
Trước khi canary real-org salary/profit: audit `authorize_tenant_action_v3` cho actor
thật (authority-graph v3 có thể hẹp hơn — IE đã phải vá 18 assignment). Tôi tự chạy
audit được khi tới bước bật real-org; chỉ cần anh chốt D1/D2 trước.

## Cách trả lời nhanh
Gõ kiểu: **"D1a: chủ nhà duyệt 1 chữ ký · D1b: trigger · D2: a · D3: a · D4: a"** — tôi
khớp lệnh và chạy nốt. Phần nào chưa chốt tôi để inert/legacy (an toàn).
