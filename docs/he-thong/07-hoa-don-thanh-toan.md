# Hoá đơn và thanh toán

> **Reviewed:** 2026-09-08
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

Mỗi payment hợp lệ có phiếu thu liên kết bằng `payment_id` + `invoice_id`. V5 ghi toàn bộ lần thu trong một transaction; sổ quỹ và KQKD đọc từ phiếu thu này. Dòng TM thối hết có thể chỉ có phiếu audit tiền thối, không có payment áp vào hoá đơn.

### `excess_amounts`

Giữ credit/nợ khách để trừ kỳ sau. V5 tạo credit cùng transaction với payment của lần thu.

## 3. Tạo và thay đổi hoá đơn

- `useInvoices` thử writer canonical (`create_invoice_v1`, update/status writers) trước và chỉ fallback khi nhận tín hiệu coexistence hợp lệ.
- Writer canonical đã bật; server kiểm organization, quyền, payload và idempotency. Không fallback khi lỗi nghiệp vụ thật.
- Sinh hàng loạt vẫn là nhiều operation; phải báo lỗi theo từng hoá đơn và không tuyên bố cả batch atomic.
- Hợp đồng/cọc/nợ cũ phải giữ đủ field parity. Không chuyển UI sang writer thiếu field vì sẽ mất dữ liệu im lặng.

## 4. Ghi nhận thanh toán hiện hành

### 4.1. Một lần thu qua V5

`recordInvoiceCollectionV5` gọi `record_invoice_collection_v5` với toàn bộ các dòng TM/TK/TT. Server khoá hoá đơn, kiểm số đã thu kỳ vọng, quyền/sổ quỹ và tính lại phân bổ. Lỗi nghiệp vụ không được chuyển sang writer cũ để bỏ qua kiểm tra.

### 4.2. Transaction của một lần thu

Các dòng TM/TK/TT của cùng một lần thu ghi atomic:

```text
payment
  + lock/recompute invoice
  + income_expenses voucher
  + income_expense_items
  + credit nếu giữ nợ khách
  + idempotency/audit
```

Nếu một bước fail, cả lần thu rollback. Retry cùng key và payload trả kết quả cũ; cùng key nhưng payload khác bị từ chối.

### 4.3. Single, bulk và `/thu-tien`

- `RecordPaymentDialog` dựng các phương thức và tiền thối thực tế rồi gọi adapter.
- `useBulkRecordPayment` lặp từng hoá đơn; mỗi hoá đơn atomic, nhưng toàn batch không nằm trong một transaction. Kết quả có thể thành công một phần.
- `/thu-tien` dùng `useQuickCollect` bọc bulk đúng một invoice, hỗ trợ một chạm hoặc form nhiều dòng TM/TK/TT.
- `p_voucher_owner_id` giữ attribution theo owner hoá đơn cho báo cáo/scope; actor vẫn được audit trong writer.

## 5. Phân bổ tiền

### Doanh thu và cọc

V5 suy phân bổ doanh thu/cọc từ các hạng mục hoá đơn ở server, ghi payment + voucher + items all-or-nothing. `kqkd_amount` chỉ tính phần doanh thu. Không bỏ qua khoản thiếu khi còn tiền cọc phải thu.

### Tiền thối

- Chỉ áp cho dòng TM.
- Có thể sửa **Tiền thối thực tế** ở Hoá đơn và cả bàn phím/form nhiều dòng trong Thu tiền. Tiền thối không được nhỏ hơn phần khách đưa dư hoặc vượt tiền mặt đã nhận.
- Số thực giữ = khách đưa − tiền thối thực tế. V5 nhận `requested_change_amount` trên từng dòng TM khi người thu sửa tiền thối, lưu vào dữ liệu lần thu và dùng số này để kiểm retry.
- Amount payment/phiếu là số ròng; metadata `change_amount`/`change_account_id` giữ dấu vết.
- Không trừ tiền thối lần hai trong báo cáo.

### Làm tròn thiếu

Khoản thiếu sau khi trừ tiền thối, **lớn hơn 0 và nhỏ hơn 10.000đ**, được lưu bằng `rounding_amount`/`rounding_account_id` và tính đóng đủ. Bao gồm khách đưa thiếu và người thu thối thêm. Đúng 10.000đ trở lên vẫn còn nợ; tiền cọc không được bỏ qua. Ví dụ cần thu 4.805.000đ, khách đưa 5.000.000đ, thối 200.000đ: thực giữ 4.800.000đ, bỏ qua 5.000đ. Khoản bỏ qua là audit, không tăng tiền thực thu. Trigger recompute quyết trạng thái cuối; không sửa status ở client.

### Giữ credit

Khi khách trả dư và chọn giữ lại, V5 tạo `excess_amounts` cho hợp đồng trong cùng RPC. Phần credit phải bằng đúng tiền dư; không sửa tiền thối trong chế độ này.

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
- **Khoản bỏ qua** mở từ Hoá đơn hoặc Thu tiền/báo cáo thu tiền: lọc kỳ hoá đơn, người thu, toà; xem tổng tiền, số hoá đơn và từng khoản khách đóng thiếu/thối thêm. `get_invoice_rounding_report_v1` tổng hợp ở SQL, phân trang chi tiết, kiểm quyền `thu_tien.report` và phạm vi toà. Kỳ lọc là kỳ hoá đơn, không phải tháng ngày thu.
- Báo cáo dùng dữ liệu rounding đã lưu; khoản cũ chỉ hiện thông tin xác định được và không cộng trùng payment với phiếu liên kết. Lần thu đã hoàn tác/phiếu đã xoá không tính vào tổng hiện hành.

## 10. Điểm cần giám sát

- Toàn batch thu nhiều hoá đơn không atomic dù từng lần thu một hoá đơn atomic.
- Resolver sổ quỹ vẫn có nhánh dựa tên `…Thu`, `…Thối`, `Chung`.
- Refund thanh lý còn flow riêng, phải kiểm approval và recompute.

## 11. Kiểm tra khi thay đổi

1. Test retry cùng idempotency key và retry khác payload.
2. Test nguồn đổi/thu song song; không vượt remaining và không double payment.
3. Test TM/TK/TT, tiền thối, rounding, credit và hoá đơn gộp cọc.
4. Test canonical reverse và lỗi “đã hoàn tác”.
5. Chạy test liên quan, `npm run typecheck:baseline` và `node scripts/reconcile-money.mjs [YYYY-MM]`.

Xem thêm [08 — Thu chi và sổ quỹ](08-thu-chi-so-quy.md), [15 — Thu tiền](15-kenh-cong-khai-sale-thu-tien.md), [19 — SOP tiền](19-sop-tien-va-so-quy.md) và [20 — Phê duyệt](20-phe-duyet-tai-chinh.md).
