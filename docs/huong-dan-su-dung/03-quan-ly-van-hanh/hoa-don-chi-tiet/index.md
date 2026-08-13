---
title: "Chi tiết, in hoá đơn & QR tra cứu"
description: "Đọc các khoản phải thu, lịch sử thanh toán, in hoá đơn và chia sẻ kênh tra cứu công khai cho khách."
routes: ["/invoices/:id", "/invoices/print/:id", "/c/:code"]
permissions: [{module: invoices, action: view}, {module: invoices, action: print}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Chi tiết, in hoá đơn & QR tra cứu

Trang chi tiết gom thông tin hợp đồng, các dòng tính tiền, tổng đã thu, còn nợ và lịch sử thanh toán của một hoá đơn.

::: info Ba đường truy cập
- `/invoices/:id` cần đăng nhập và quyền `invoices.view`.
- `/invoices/print/:id` cần quyền `invoices.print`.
- `/c/:code` là kênh công khai, khách không cần đăng nhập. Kênh này không hiển thị nếu mã không tồn tại, dữ liệu đã bị xoá hoặc hợp đồng đã chấm dứt.
:::

## Cách kiểm tra hoá đơn

::: info Snapshot DEMO hiện chưa có hoá đơn
Lần kiểm tra production ngày 13/08/2026 bằng `demo.chunha`, `/invoices` hiển thị **Chưa có hoá đơn nào**. Vì vậy ảnh dưới đây chứng minh đúng điểm vào và empty state hiện tại, không phải một bản ghi chi tiết giả lập. Các bước từ Bước 2 áp dụng khi tổ chức đã có hoá đơn thật.
:::

**Bước 1**: Từ danh sách, mở hoá đơn cần xem. Nếu màn đang hiện **Chưa có hoá đơn nào**, dừng tại đây; không có route chi tiết hợp lệ để kiểm tra hoặc in.

![Danh sách Hoá đơn của DEMO ở trạng thái chưa có hoá đơn](./images/buoc-01-chi-tiet.webp)

**Bước 2**: Đối chiếu theo thứ tự:

1. Hợp đồng, phòng, kỳ và hạn thanh toán.
2. Các dòng tiền và tổng giá trị hoá đơn.
3. Tổng đã thanh toán và số còn nợ.
4. Lịch sử từng lần thu, phương thức, sổ quỹ và trạng thái chứng từ.

**Bước 3**: Nếu được phép, chọn **In hoá đơn**. Trang in dùng route riêng và mẫu in hiện hành của tổ chức.

**Bước 4**: Dùng mã QR hoặc đường dẫn công khai để khách tự xem thông tin được công bố. Luôn thử đường dẫn trước khi gửi nếu hợp đồng vừa thay đổi trạng thái.

## Thu, hoàn tác và hoàn tiền

- Thu tiền được thực hiện qua luồng [Thu tiền tại hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/).
- Khi một lần thu bị sai, dùng chức năng **Hoàn tác/Đảo thu**. Hệ thống giữ dấu vết kiểm toán và có thể huỷ tại chỗ hoặc tạo chứng từ đối ứng tuỳ chế độ kế toán.
- Không xoá phiếu thu để làm mất lịch sử thanh toán.

::: danger Hoàn tiền chưa phải chi tiền ngay
Hộp thoại hoàn tiền hiện cho chọn **ngày** và **sổ quỹ**, nhưng hai giá trị này chưa được áp dụng bởi luồng ghi hiện hành. Thao tác chỉ tạo một **nghĩa vụ hoàn tiền đang chờ**, chưa làm tiền ra khỏi quỹ. Sau khi tạo, kiểm tra phiếu chờ và thực hiện duyệt/post theo quy trình tài chính; không coi nút **Lập phiếu chi** là đã chi tiền.
:::

## Khi số liệu chưa khớp

- Đối chiếu từng lần thu thay vì chỉ nhìn trạng thái tổng.
- Kiểm tra các lần đảo thu hoặc chứng từ đối ứng.
- Phân biệt số còn nợ trên hoá đơn với số dư sổ quỹ và tín dụng còn lại của khách.

## Quy trình liên quan

- [Hoá đơn — danh sách & tạo lẻ](/03-quan-ly-van-hanh/hoa-don/)
- [Thu tiền tại hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)
- [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/invoices" app-label="Mở danh sách Hoá đơn" fixtures="Snapshot 13/08/2026: chưa có hoá đơn." view-only>

1. Xác nhận trang tải xong và hiện **Chưa có hoá đơn nào**.
2. Nhận diện bộ lọc và nút tạo lẻ nhưng không tạo dữ liệu trong bài kiểm tra này.
3. Khi tổ chức có hoá đơn, mở đúng dòng rồi đối chiếu hợp đồng, phòng, kỳ, tổng tiền, đã thu và còn nợ theo thứ tự ở trên.

Kết quả mong đợi: bạn không nhầm empty state của danh sách với trang chi tiết và chỉ dùng route `/invoices/:id` khi có một hoá đơn thật.

</SandboxTry>
