---
title: "Thu tiền tại hoá đơn"
description: "Ghi nhận một lần thu cho hoá đơn bằng TM/TK/TT, phân bổ cọc và doanh thu, hoặc hoàn tác bằng chứng từ đảo."
routes: ["/invoices", "/invoices/:id"]
permissions: [{module: invoices, action: view}, {module: invoices, action: record_payment}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Thu tiền tại hoá đơn

Luồng này ghi một lần thanh toán vào đúng hoá đơn và sổ quỹ. Bạn cần quyền xem hoá đơn và quyền `invoices.record_payment` để dùng nút thu.

::: info Ảnh production hiện là điểm vào, chưa phải hộp thoại Thu tiền
Snapshot `demo.chunha` ngày 13/08/2026 không có hoá đơn, nên `/invoices` dừng ở empty state **Chưa có hoá đơn nào**. Không thể mở nút **Thu tiền** hoặc chụp hộp thoại mà không tạo dữ liệu tài chính. Ảnh dưới đây ghi lại đúng trạng thái đó; phần thao tác áp dụng khi đã có hoá đơn còn nợ.
:::

## Ghi nhận một lần thu

**Bước 1**: Mở danh sách hoá đơn. Nếu có hoá đơn còn nợ, mở đúng dòng, kiểm tra **còn nợ** rồi chọn **Thu tiền**. Nếu trang hiện **Chưa có hoá đơn nào**, dừng; không có khoản nào để thu.

![Danh sách Hoá đơn DEMO đang ở trạng thái chưa có hoá đơn để thu](./images/buoc-01-thu-tien.webp)

**Bước 2**: Nhập số tiền theo từng phương thức:

- `TM`: tiền mặt.
- `TK`: chuyển khoản vào tài khoản/sổ được chọn.
- `TT`: phương thức thu khác được hệ thống hỗ trợ.

Chọn đúng sổ quỹ cho từng phần tiền và kiểm tra tổng nhận trước khi xác nhận.

**Bước 3**: Nếu khoản thu có cả tiền cọc và doanh thu, phân bổ các dòng ngay trong cùng lần thu. Phần cọc và phần doanh thu là **các item của cùng một collection/voucher**, không phải hai phiếu thu độc lập.

**Bước 4**: Xác nhận và mở lại lịch sử thanh toán để kiểm tra mã chứng từ, tổng đã thu và còn nợ.

::: info Tính nguyên tử của một hoá đơn
Luồng hiện hành dùng `record_invoice_collection_v5`: mọi phần `TM/TK/TT` của **một hoá đơn** được ghi trong một giao dịch nguyên tử. Nếu một phần lỗi, toàn bộ lần thu đó không được ghi dở dang.
:::

::: warning Thu nhiều hoá đơn
Thao tác hàng loạt trên nhiều hoá đơn vẫn chạy thành nhiều giao dịch. Một số hoá đơn có thể thành công trước khi hoá đơn khác lỗi; luôn đọc kết quả từng dòng và đối soát các hoá đơn đã ghi.
:::

## Hoàn tác lần thu

Chọn lần thu cần sửa và dùng **Hoàn tác/Đảo thu**. Writer chuẩn là `reverse_invoice_collection_v5` (hoặc đường tương thích cho dữ liệu cũ).

- Ở chế độ kế toán chuẩn, hệ thống có thể tạo chứng từ đối ứng.
- Ở một số chế độ tương thích, chứng từ có thể được huỷ tại chỗ.
- Cả hai cách đều giữ dấu vết kiểm toán và cập nhật lại số đã thu/còn nợ.

Không xoá phiếu thu hoặc chỉnh trực tiếp số dư để sửa một lần thu.

## Hoàn tiền cho khách

::: danger Luồng hiện tại tạo nghĩa vụ chờ hoàn
Hộp thoại hoàn tiền có trường ngày và sổ quỹ, nhưng writer hiện tại chưa dùng hai giá trị này. Nó chỉ gọi `create_invoice_refund_obligation_v2` để tạo nghĩa vụ hoàn tiền đang chờ, chưa phát sinh dòng tiền ra. Sau đó phải kiểm tra phiếu chờ, duyệt và post theo [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/). Công thức số còn phải hoàn hiện cũng có vấn đề đã biết, vì vậy phải đối chiếu số tiền trước khi duyệt.
:::

## Quy trình liên quan

- [Chi tiết, in hoá đơn & QR tra cứu](/03-quan-ly-van-hanh/hoa-don-chi-tiet/)
- [Thu tiền tại phòng trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/)
- [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/)
- [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/)

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/invoices" app-label="Mở danh sách Hoá đơn" fixtures="Snapshot 13/08/2026: chưa có hoá đơn để thu." view-only>

1. Xác nhận empty state **Chưa có hoá đơn nào** và không cố mở một URL chi tiết tự đoán.
2. Nhận diện vị trí bộ lọc/danh sách; không tạo hoá đơn hoặc ghi nhận thanh toán trong bài chỉ xem.
3. Khi có hoá đơn thật, chỉ thu trên dòng còn nợ và kiểm tra lại lịch sử collection sau khi xác nhận.

Kết quả mong đợi: bạn biết điều kiện bắt buộc để mở luồng Thu tiền là phải có một hoá đơn thật còn nợ.

</SandboxTry>
