---
title: "Báo cáo: Khuyến mãi"
description: "Đọc giảm giá lưu trong JSON discounts của hợp đồng và cách report quy đổi phần trăm hoặc số tiền cố định."
routes: ["/reports/real-estate/promotions"]
permissions: [{module: reports_real_estate, action: promotions}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Khuyến mãi

Route cần `reports_real_estate.promotions`. Báo cáo liệt kê hợp đồng chưa xóa có trường JSON `discounts` khác `NULL`; nó không kiểm tra một bảng chương trình khuyến mại riêng.

![Màn hình báo cáo Khuyến mãi](./images/buoc-01-man-hinh.webp)

## Bộ lọc và nguồn số

- Khoảng ngày là tùy chọn; để trống sẽ tải mọi hợp đồng có `discounts` trong phạm vi.
- Khi có khoảng ngày, report lọc theo `signed_date`.
- Tòa được lọc client-side sau khi truy vấn quan hệ phòng → tòa.
- Kết quả sắp xếp theo ngày ký mới nhất.

Hook đọc `discounts.amount` hoặc fallback `discounts.value`. Kiểu giảm:

- `type = "percent"`: `savings = rent_price × mức giảm / 100`.
- Kiểu khác hoặc thiếu: coi là số tiền cố định.
- `effective_rent = max(rent_price - savings, 0)`.

Tên ưu đãi có thể lấy từ `discounts.name` hoặc `discounts.description`, nhưng component hiện không hiển thị tên trong bảng/export.

## Bốn thẻ số

- **Tổng HĐ có giảm giá**: số dòng có JSON `discounts` khác null.
- **Đang hoạt động**: số hợp đồng trong danh sách có `status = ACTIVE`; đây là trạng thái hợp đồng, không phải cửa sổ hiệu lực riêng của khuyến mại.
- **Tổng giảm giá**: cộng `savings` của mỗi hợp đồng một lần.
- **TB mỗi hợp đồng**: tổng giảm chia số dòng.

::: warning Không phải tổng ưu đãi toàn thời hạn
`savings` là mức giảm quy đổi từ giá thuê của một hợp đồng, thường mang ý nghĩa theo tháng. Report cộng một lần mỗi hợp đồng; nó không nhân với số tháng, chu kỳ áp dụng hoặc số hóa đơn. Vì vậy “Tổng giảm giá” không phải số tiền khuyến mại đã thực hiện trên sổ hoặc toàn thời hạn hợp đồng.
:::

Bảng và file `bao-cao-khuyen-mai` gồm giá gốc, giảm giá, giá sau giảm và trạng thái. Trạng thái chỉ có trong export, không có cột riêng trên bảng.

## Giới hạn

- Truy vấn không phân trang rõ ràng; dữ liệu lớn có thể chịu cap API.
- Hợp đồng có `discounts = {}` vẫn thỏa điều kiện khác null và có thể xuất hiện với giảm 0.
- Report không đối chiếu hóa đơn đã áp giảm hoặc tiền thực thu.

## Quy trình liên quan

- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/)
- [Cho thuê mới](/04-bao-cao/cho-thue-moi/)
- [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/)
