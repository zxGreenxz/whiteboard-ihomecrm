# Kiểm tra cảnh báo thiếu cọc trên phiếu hoa hồng — 08/09/2026

Đo production lúc **11:45 ngày 08/09/2026 (UTC+7)**, bằng các transaction `READ ONLY`. Không sửa dữ liệu, không đổi trạng thái phiếu, không ghi migration. [Bằng chứng JSON và câu SQL rà soát](2026-09-08-commission-deposit-classification.json) chỉ chứa thông tin phòng, tòa, chứng từ và số tiền; không chứa tên hay số điện thoại khách.

## Kết luận

**Có 2 phiếu hoa hồng đang báo thiếu cọc do cùng một lỗi phân loại khi sửa hóa đơn:** phòng **501/102LVT** và **305/80DS3**. Tổng tiền cọc đã thu nhưng bị xếp vào doanh thu ở hai trường hợp này là **3.800.000đ**.

Rà rộng dữ liệu hóa đơn tìm thêm 2 trường hợp cùng dấu vết, hiện không có phiếu hoa hồng còn hiệu lực. Cả 4 hóa đơn đều có lịch sử ghi rõ: dòng `DEPOSIT` bị xóa rồi được tạo lại thành `REVENUE`, giữ nguyên mô tả và số tiền.

| Phòng / tòa | Hóa đơn | Cọc bị phân loại sai, hóa đơn đã thu đủ | Phiếu hoa hồng hiện tại | Ghi nhận cọc hiện tại / phải thu |
|---|---|---:|---|---:|
| 501 / 102LVT | INV-2026-00802 | 2.200.000đ | PC2608155 — 2.940.000đ, chưa duyệt | 2.000.000đ / 4.200.000đ |
| 305 / 80DS3 | INV-2026-00823 | 1.600.000đ | PC2608062 — 2.160.000đ, chưa duyệt | 2.000.000đ / 3.600.000đ |
| 102 / 102LVT | INV-2026-00622 | 3.900.000đ | Không có trong tập phiếu hiện tại | 0đ / 3.900.000đ |
| 203 / 111PVC | INV-2026-00598 | 3.600.000đ | Không có trong tập phiếu hiện tại | 0đ / 3.600.000đ |

Tổng dòng cọc bị phân loại sai ở 4 hóa đơn: **11.300.000đ**. Hợp đồng của phòng 102/102LVT đã thanh lý; đây là bằng chứng sai phân loại lịch sử, không phải kết luận rằng hiện còn giữ đủ số cọc đó.

## Dấu vết phòng 501/102LVT

Hợp đồng **HD-2026-00316** có cọc phải thu 4.200.000đ, chọn thu phần còn thiếu ở hóa đơn đầu.

1. **31/08, 10:20:42:** tạo hợp đồng và hóa đơn INV-2026-00802. Dòng “Tiền cọc” 2.200.000đ được tạo đúng với `accounting_class = DEPOSIT`.
2. **31/08, 10:32:21:** sửa hóa đơn. Hệ thống xóa các dòng cũ và tạo lại; “Tiền cọc” vẫn 2.200.000đ nhưng đổi thành `OTHER / REVENUE`. Tổng hóa đơn đổi từ 7.511.000đ thành 7.490.000đ.
3. Phiếu thu **PT2609024** thu đủ 7.490.000đ, đã duyệt và ghi sổ. Ngày chứng từ là **31/08**; thời điểm nhập hệ thống là **04/09, 17:33:27**. Toàn bộ tiền được phân bổ vào một dòng `PNL` 7.490.000đ; không còn dòng cọc.
4. Phiếu **PT2608076**, ngày 26/08, số tiền 2.000.000đ, sổ TK939, nguồn `contract.create.v2`, đã duyệt và ghi sổ, có đúng dòng `DEPOSIT` 2.000.000đ. Phiếu này gắn trực tiếp vào hợp đồng, không thiếu liên kết.

Vì vậy bộ dữ kiện hoa hồng chỉ nhận 2.000.000đ cọc và báo thiếu 2.200.000đ. **Tiền đã thu; sai ở phân loại khoản thu.** Việc sửa chữ cảnh báo hoặc ép `deposit_paid` sẽ không sửa được nguồn kế toán đã ghi sai.

Mã PT2608076 có 3 bản ghi ở tổ chức thật. Bản trong kiểm tra được xác định bằng **ID, hợp đồng, ngày, số tiền và sổ**, không dùng riêng mã chứng từ để kết luận. ID của mọi chứng từ liên quan nằm trong JSON.

## Nguyên nhân trong mã đang chạy

- Catalog production của `create_contract_v2` có ghi `accounting_class` khi tạo dòng hóa đơn. Lịch sử hóa đơn 501 chứng minh bước tạo ban đầu đúng.
- Catalog production của **`update_invoice_v1`** xóa toàn bộ `invoice_items` rồi chèn lại, nhưng danh sách cột chèn **không có `accounting_class`**. Dòng mới nhận mặc định `REVENUE`. Không có trigger tự khôi phục phân loại trên `invoice_items`.
- Luồng giao diện sửa hóa đơn cũng không giữ trường này: truy vấn và payload trong [useInvoices.ts](../../src/hooks/useInvoices.ts), cùng ánh xạ trong [EditInvoiceDialog.tsx](../../src/components/invoices/EditInvoiceDialog.tsx).
- `record_invoice_collection_v5` phân bổ tiền theo lớp kế toán đã lưu ở dòng hóa đơn. Sau lần sửa, 2.200.000đ bị xem là doanh thu.
- `commission_contract_facts_v1` cộng đúng các hạng mục thu/chi có lớp `DEPOSIT` của phiếu đã duyệt, chưa xóa, gắn hợp đồng trực tiếp hoặc qua `contract_deposit_links`. Nó không thể coi mọi hóa đơn `PAID` là đã thu đủ cọc.

JSON lưu MD5 định nghĩa các hàm production đã đọc để đối chiếu khi chuẩn bị sửa. Chưa thực hiện thay đổi mã hoặc dữ liệu cho lỗi này.

## Đối chiếu phòng 505/102LVT

Phiếu **PC2609018**, hợp đồng **HD-2026-00359**, đang hiện đúng:

- PT2609083: cọc giữ chỗ **2.000.000đ**.
- INV-2026-00960: phải thu **8.074.000đ**, gồm doanh thu **5.074.000đ** và cọc **3.000.000đ** vẫn mang lớp `DEPOSIT`.
- PT2609084: thu **8.000.000đ**, phân bổ doanh thu **5.074.000đ** và cọc **2.926.000đ**.
- Tổng cọc được ghi nhận **4.926.000đ / 5.000.000đ**; còn thiếu thật **74.000đ**.

Phòng 305/80DS3 có cảnh báo thiếu cọc sai, nhưng điều kiện **đủ 7 ngày** vẫn chưa đạt đến **12/09/2026**. Phòng 505 phải chờ đến **14/09/2026** cho điều kiện này. Kết quả kiểm tra cọc không đồng nghĩa với việc các phiếu đều đủ điều kiện duyệt ngay. Phòng 501 đã đạt mốc 7 ngày từ 07/09.

## Phạm vi và giới hạn

- Tập phiếu hoa hồng đang tồn tại, chưa hủy của tổ chức thật: **137 phiếu / 107 hợp đồng**, trong đó **60 phiếu chưa duyệt**.
- Rà toàn bộ dòng hóa đơn hiện tại có tên “Tiền cọc” nhưng không mang lớp `DEPOSIT`, rồi kiểm tra lịch sử; tìm được 4 hóa đơn trên.
- Kiểm chéo độc lập không phụ thuộc tên dòng: tìm dòng hiện tại có lịch sử xóa `DEPOSIT` và tạo lại `REVENUE` trong cùng thời điểm giao dịch, cùng mô tả và số tiền; vẫn ra đúng 4 hóa đơn.
- Trong tập phiếu hoa hồng hiện tại, **2 phiếu** liên quan lỗi đã chứng minh. Những phiếu khác không có dấu vết này trong phạm vi rà; đây không phải xác nhận mọi điều kiện nghiệp vụ của 135 phiếu còn lại đều đúng.
- Chưa xác minh các trường hợp không còn đủ lịch sử, đã đổi cả tên/số tiền, hoặc đã xóa/hủy. Chưa sửa số liệu hay chạy lại duyệt tự động.

## Phát hiện riêng, chưa xử lý

Ở hợp đồng phòng 505, `resolve_signed_contract_deposit_basis_v1` trả **netHeld = 10.000.000đ**, do hàm nguồn `contract_deposit_sources_v1` lấy cả tổng phiếu 8.000.000đ khi phiếu có một hạng mục cọc, rồi cộng phiếu giữ chỗ 2.000.000đ. Bộ dữ kiện ghi chú hoa hồng dùng tổng **hạng mục cọc** nên vẫn hiện đúng **4.926.000đ**.

Đây là sai lệch riêng của bộ tính cơ sở tiền cọc, khác nguyên nhân phân loại ở phòng 501. Chỉ ghi nhận số đo và nguồn trong JSON; chưa mở rộng sửa hoặc kết luận ảnh hưởng đến mọi nơi gọi hàm này.

## Tái hiện chính xác khi chỉ sửa ghi chú — 11:51 ngày 08/09

**Tên “Tiền cọc”, loại hiển thị “Khác” và số tiền không đổi; trường phân loại kế toán phía sau bị mất khi bấm lưu.** Lịch sử xóa/thêm dòng là thao tác tự động của hàm lưu: hàm luôn viết lại toàn bộ dòng, kể cả chỉ sửa ghi chú. Không có bằng chứng để kết luận người dùng đã tự xóa khoản cọc hoặc chọn sai loại.

Đã gọi đúng hàm `update_invoice_v1` đang chạy, dưới role `authenticated` của chủ nhà DEMO. Hai hóa đơn thử có doanh thu 5.290.000đ và cọc 2.200.000đ, tổng 7.490.000đ; mỗi lần chỉ thay ghi chú. Không tạo/sửa hàm hay thay cơ chế phân quyền.

| Phép thử | Yêu cầu gửi tới máy chủ | Trước lưu | Sau lưu |
|---|---|---|---|
| Payload như giao diện hiện tại | Không có `accounting_class`; tên/số tiền giữ nguyên | `OTHER / DEPOSIT`, “Tiền cọc”, 2.200.000đ | `OTHER / REVENUE`, “Tiền cọc”, 2.200.000đ |
| Gửi rõ lớp kế toán | Có `accounting_class: DEPOSIT`; tên/số tiền giữ nguyên | `OTHER / DEPOSIT`, “Tiền cọc”, 2.200.000đ | `OTHER / REVENUE`, “Tiền cọc”, 2.200.000đ |

Hai điểm lỗi đã được phân biệt: giao diện không bảo toàn trường phân loại trong dữ liệu gửi; máy chủ cũng không đọc/lưu trường đó **ngay cả khi có gửi rõ**. Vì vậy chỉ thêm trường ở giao diện chưa đủ sửa luồng đang chạy. Mặc định cột trên live là `'REVENUE'::text`; MD5 hàm live: `c18b3cdb867d5883e4800a269fe1459e`.

[Bằng chứng đầy đủ](2026-09-08-invoice-edit-deposit-proof.json) gồm JSON yêu cầu, dữ liệu trước/sau, toàn bộ định nghĩa hàm live, mặc định cột và trích trường gốc trong lịch sử phòng 501. [SQL tái hiện](2026-09-08-invoice-edit-deposit.probe.sql) là phép quan sát lỗi hiện tại, không nằm trong bộ test tự chạy. Chạy toàn bộ batch qua harness Management Query DEMO; hai tình huống trả `BUG_REPRODUCED`. Sau khi sửa lỗi, kỳ vọng phép quan sát này phải dừng vì không còn tái hiện lỗi cũ.

Toàn bộ hai phép thử nằm trong `BEGIN / ROLLBACK`. Truy vấn `READ ONLY` độc lập sau đó xác nhận **0 hóa đơn fixture còn tồn tại**. Không thay dữ liệu tổ chức thật hoặc trạng thái phiếu hoa hồng.
