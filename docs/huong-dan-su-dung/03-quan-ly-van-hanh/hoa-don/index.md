---
title: "Hoá đơn — danh sách & tạo lẻ"
description: "Xem, lọc và tra cứu hoá đơn; tạo hoá đơn lẻ hoặc mở luồng sinh hàng loạt theo đúng quyền được cấp."
routes: ["/invoices"]
permissions: [{module: invoices, action: view}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-08-13"
  commit: "c6e8e4584b0a43a543ac0dd296f49c53f7e85d6b"
  account: demo.chunha
status: published
---

# Hoá đơn — danh sách & tạo lẻ

Màn **Hoá đơn** là nơi tra cứu các khoản phải thu theo hợp đồng, phòng và kỳ. Bạn có thể mở chi tiết, in, ghi nhận thanh toán hoặc tạo hoá đơn nếu được cấp thêm quyền tương ứng.

::: info Quyền truy cập
- Mở danh sách và chi tiết cần `invoices.view`.
- Các nút **Tạo**, **Sinh hoá đơn**, **Thu tiền**, **In** và thao tác khác được kiểm tra bằng quyền hành động riêng. Thấy danh sách không đồng nghĩa với được dùng mọi nút.
:::

## Cách làm việc

**Bước 1**: Vào **Vận hành → Hoá đơn**. Dùng bộ lọc kỳ, toà, phòng, hợp đồng và trạng thái để thu hẹp danh sách.

![Màn Hoá đơn production của DEMO đang rỗng, các thẻ Tổng tiền, Đã thu, Phải thu và phương thức đều bằng 0](./images/buoc-01-danh-sach.webp)

::: warning Snapshot DEMO hiện chưa có hoá đơn
Ngày 13/08/2026, bộ lọc mặc định của `demo.chunha` hiển thị **Chưa có hoá đơn nào** và mọi tổng đều bằng 0. Ảnh này chứng minh empty state và các bộ lọc hiện hành; nó không phải ví dụ về một hoá đơn có thể thu.
:::

**Bước 2**: Đọc các cột chính:

| Cột | Ý nghĩa |
| --- | --- |
| Kỳ / hạn thanh toán | Kỳ dịch vụ và ngày khách cần thanh toán. |
| Tổng tiền | Tổng giá trị các dòng trên hoá đơn. |
| Đã thanh toán | Số đã được ghi nhận qua các lần thu hợp lệ. |
| Còn nợ | Phần còn phải thu tại thời điểm xem. |
| Trạng thái | Chưa thu, thu một phần, đã thu, quá hạn hoặc trạng thái nghiệp vụ khác. |

**Bước 3**: Bấm một dòng để mở [Chi tiết, in hoá đơn & QR tra cứu](/03-quan-ly-van-hanh/hoa-don-chi-tiet/). Tại đó bạn kiểm tra từng khoản, lịch sử thu và các thao tác được phép.

**Bước 4**: Khi cần tạo một hoá đơn lẻ, chọn đúng hợp đồng và kỳ, kiểm tra các dòng tiền rồi lưu. Luồng ghi hiện hành tạo hoá đơn ở trạng thái **APPROVED**.

::: warning Thiết lập tự động duyệt
Thiết lập **Tự động duyệt hoá đơn** hiện không điều khiển writer chuẩn đang tạo hoá đơn. Vì vậy hãy kiểm tra trạng thái thực tế sau khi lưu, không dùng thiết lập này để suy ra hoá đơn sẽ ở trạng thái nào.
:::

## Tạo lẻ hay sinh hàng loạt

- **Tạo lẻ** phù hợp khi bổ sung một hoá đơn riêng hoặc xử lý ngoại lệ.
- **Sinh hàng loạt** phù hợp khi phát hành cho nhiều phòng trong cùng toà/kỳ; xem [Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/sinh-hoa-don/).
- Trước khi tạo lại, lọc đúng hợp đồng và kỳ để tránh trùng hoá đơn.

## Lưu ý đối soát

- **Còn nợ** là số phải thu của hoá đơn, không phải số dư sổ quỹ.
- Tiền chỉ đi vào sổ quỹ khi nghiệp vụ thu được ghi nhận/post theo luồng tài chính hiện hành.
- Nếu thu sai, dùng thao tác hoàn tác/đảo thu có sẵn; không xoá chứng từ để sửa lịch sử.

## Quy trình liên quan

- [Chi tiết, in hoá đơn & QR tra cứu](/03-quan-ly-van-hanh/hoa-don-chi-tiet/)
- [Thu tiền tại hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)
- [Thu tiền tại phòng trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/)
- [Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/sinh-hoa-don/)
