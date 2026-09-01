# Hoá đơn và thanh toán

> **Reviewed:** 2026-09-02
> Nguồn hiện hành: `src/hooks/useInvoices.ts`, `src/hooks/useInvoicePayments.ts`, `src/hooks/useBulkRecordPayment.ts`, `src/lib/paymentRecordRpc.ts` và writer/RPC mới nhất.

> **Phạm vi file này:** vòng đời hoá đơn (tạo/sửa/duyệt/huỷ) và ghi nhận thanh toán TRÊN hoá đơn.
> **KHÔNG nói về:** phiếu thu/chi + sổ quỹ + posting — xem `08-thu-chi-so-quy.md`; quy trình con
> người cầm tiền — `19-sop-tien-va-so-quy.md`; luật phê duyệt — `20-phe-duyet-tai-chinh.md`.
> Audit mới nhất của chủ đề: `docs/audits/AUDIT-THANH-TOAN-2026-08-31.md` — **13/13 finding đã vá
> 01/09** (commit `b8b3fe83`).

## 1. Phạm vi

Domain này quản lý:

- tạo/sửa/duyệt/huỷ hoá đơn — **từ 01/09/2026 UI chỉ còn MỘT nút Huỷ** (nút Xoá đã gom về Huỷ,
  commit `2bc2972c`, hết đường "bốc hơi" hoá đơn; `canCancelInvoice` là hàng rào duy nhất — RPC
  không tự guard; phục hồi mở cho user thường; đường xoá mềm chỉ còn ở tầng dữ liệu/legacy);
- hạng mục tiền phòng, dịch vụ, điện nước, nợ cũ và cọc;
- ghi nhận TM/TK/TT, tiền thối, làm tròn và credit;
- recompute số đã thu/còn lại/trạng thái;
- hoàn tác payment có audit thay vì xoá lịch sử mặc định.

Routes chính: `/invoices`, `/invoices/:id`, `/thu-tien` và các dialog thu tiền trong chi tiết hoá đơn.

## 2. Dữ liệu chính

### `invoices`

- Neo `organization_id`, `building_id`, `room_id`, `contract_id`, `billing_month`.
- Số tiền gồm subtotal/discount/previous debt/credit và `total_amount` cuối.
- `paid_amount`/`remaining_amount`/status là giá trị được recompute từ bút toán; không sửa tay từ UI.
- `previous_debt_sources` giữ nguồn nợ kéo sang để tất toán đúng hoá đơn gốc.

### `invoice_items`

- Dòng tiền phòng, dịch vụ, điện/nước, cọc và khoản khác.
- Hạng mục cọc phải được phân loại cấu trúc để phần đó không vào KQKD.

### `payments`

- Một dòng cho mỗi phương thức/amount đã ghi.
- Liên kết hoá đơn, ngày thanh toán, method và audit actor/owner.
- Hoàn tác canonical giữ dòng gốc và tạo dấu vết đối ứng; không mặc định hard-delete.

### `income_expenses`

Mỗi payment hợp lệ có phiếu thu liên kết bằng `payment_id` + `invoice_id`. Phiếu và items được ghi cùng transaction với payment trong writer v3/v4; sổ quỹ và KQKD đọc từ phiếu thu này.

### `excess_amounts`

Giữ credit/nợ khách để trừ kỳ sau. Trong flow bulk hiện hành, bước tạo credit diễn ra sau payment RPC, nên incident ở đúng khe này phải đối chiếu payment với credit record.

## 3. Tạo và thay đổi hoá đơn

- `useInvoices` thử writer canonical (`create_invoice_v1`, update/status writers) trước và chỉ fallback khi nhận tín hiệu coexistence hợp lệ.
- Writer canonical đã bật; server kiểm organization, quyền, payload và idempotency. Không fallback khi lỗi nghiệp vụ thật.
- Sinh hàng loạt vẫn là nhiều operation; phải báo lỗi theo từng hoá đơn và không tuyên bố cả batch atomic.
- Hợp đồng/cọc/nợ cũ phải giữ đủ field parity. Không chuyển UI sang writer thiếu field vì sẽ mất dữ liệu im lặng.

## 4. Ghi nhận thanh toán hiện hành

### 4.1. Adapter v4 → v3

`recordInvoicePaymentWithFallback` dùng cùng payload 12 tham số cho:

1. `record_invoice_payment_v4` — route canonical theo organization;
2. `record_invoice_payment_v3` — writer coexistence khi v4 chưa deploy, route chưa bật hoặc bị deny có chủ đích trong giai đoạn drain.

Chỉ ba tín hiệu được fallback: function chưa có trong schema cache, thông báo rollout “chưa bật”, hoặc `42501` coexistence. Lỗi idempotency, dữ liệu, tiền hay permission thật phải throw.

### 4.2. Transaction của một dòng thanh toán

Mỗi dòng TM/TK/TT ghi atomic:

```text
payment
  + lock/recompute invoice
  + income_expenses voucher
  + income_expense_items
  + idempotency/audit
```

Nếu một bước fail, cả dòng rollback. Retry cùng key trả kết quả cũ, tránh payment đôi do mất mạng.

### 4.3. Single, bulk và `/thu-tien`

- `RecordPaymentDialog` dựng payload doanh thu/cọc rồi gọi adapter.
- `useBulkRecordPayment` lặp từng hoá đơn và từng sub-line; mỗi sub-line atomic, nhưng toàn batch không nằm trong một transaction. Kết quả có thể thành công một phần.
- `/thu-tien` dùng `useQuickCollect` bọc bulk đúng một invoice, hỗ trợ một chạm hoặc form nhiều dòng TM/TK/TT.
- `p_voucher_owner_id` giữ attribution theo owner hoá đơn cho báo cáo/scope; actor vẫn được audit trong writer.

## 5. Phân bổ tiền

### Doanh thu và cọc

Hoá đơn có phần cọc chỉ thu qua flow biết phân bổ. Client tính `depositPortion`/`revenuePortion`, truyền hai item có loại đúng; server ghi payment + voucher + items all-or-nothing. `kqkd_amount` chỉ tính phần doanh thu.

Bulk chặn hoá đơn gộp cọc nếu chưa có đủ logic phân bổ cho plan đó.

### Tiền thối

- Chỉ áp cho dòng TM.
- Amount payment/phiếu là số ròng; metadata `change_amount`/`change_account_id` giữ dấu vết.
- Không trừ tiền thối lần hai trong báo cáo.

### Làm tròn thiếu

Residual dưới ngưỡng được gắn `rounding_amount`/`rounding_account_id` vào voucher. Trigger recompute quyết trạng thái cuối; không sửa status ở client.

### Giữ credit

Khi khách trả dư và chọn giữ lại, payment vẫn đi qua RPC; record `excess_amounts` được tạo cho hợp đồng. Đây là bước cần đối chiếu riêng vì chưa nằm trong cùng RPC với payment.

## 6. Recompute trạng thái

Trigger/RPC recompute tổng hợp các payment hợp lệ và điều chỉnh liên quan để cập nhật:

- `paid_amount`;
- `remaining_amount`;
- `PARTIAL_PAID`/`PAID` hoặc trạng thái hợp lệ tương ứng;
- settlement nợ cũ/cọc khi flow yêu cầu.

`OVERDUE` thường là trạng thái suy theo ngày đến hạn ở lớp đọc/hiển thị, không phải lý do để client ghi đè status.

## 7. Hoàn tác và hoàn trả

- `useDeletePayment` mặc định gọi `reverse_invoice_payment_v3` với idempotency và reason. Writer tạo bút toán đối ứng, recompute hoá đơn và giữ audit.
- Chỉ các payment legacy/paired đặc biệt mới rơi về đường xoá cũ theo tín hiệu được phân loại.
- Lỗi “đã hoàn tác”, conflict hoặc permission từ canonical phải hiển thị, không fallback sang xoá.
- Hoàn trả hoá đơn thanh lý âm là flow EXPENSE riêng và thuộc nhóm bắt buộc duyệt; chỉ phiếu đã duyệt mới được recompute tính vào settlement.

## 8. Phê duyệt và quyền

- Xem/tạo/sửa/thu/hoàn tác được kiểm qua permission catalog và scope organization/building.
- Payment writer kiểm quyền ở backend; ẩn nút ở UI chỉ là UX.
- Request/phiếu thuộc nhóm bắt buộc duyệt đi qua approval engine; maker không tự duyệt request của mình.
- Không direct insert/update vào bảng tiền để vượt writer hoặc approval.

## 9. Sổ quỹ và báo cáo

- Phiếu thu liên kết payment làm tăng đúng sổ `account_id` theo phương thức.
- `kqkd_amount` loại cọc và khoản ngoài KQKD.
- Báo cáo công nợ hiện được xử lý trong luồng `/thu-tien`; hai route báo cáo cũ redirect về đó.
- Đối chiếu tiền phải fetch đủ dòng hoặc dùng SQL aggregate, không tổng 1.000 dòng đầu.

## 10. Điểm cần giám sát

- Toàn batch thu nhiều hoá đơn không atomic dù từng sub-line atomic.
- Credit `excess_amounts` còn bước sau RPC.
- Resolver sổ quỹ vẫn có nhánh dựa tên `…Thu`, `…Thối`, `Chung`.
- Fallback v3 tồn tại tới khi T7 drain hoàn tất; không được hiểu là canonical writer chưa live.
- Refund thanh lý còn flow riêng, phải kiểm approval và recompute.

## 11. Kiểm tra khi thay đổi

1. Test retry cùng idempotency key và retry khác payload.
2. Test nguồn đổi/thu song song; không vượt remaining và không double payment.
3. Test TM/TK/TT, tiền thối, rounding, credit và hoá đơn gộp cọc.
4. Test canonical reverse và lỗi “đã hoàn tác”.
5. Chạy test liên quan, `npm run typecheck:baseline` và `node scripts/reconcile-money.mjs [YYYY-MM]`.

Xem thêm [08 — Thu chi và sổ quỹ](08-thu-chi-so-quy.md), [15 — Thu tiền](15-kenh-cong-khai-sale-thu-tien.md), [19 — SOP tiền](19-sop-tien-va-so-quy.md) và [20 — Phê duyệt](20-phe-duyet-tai-chinh.md).
