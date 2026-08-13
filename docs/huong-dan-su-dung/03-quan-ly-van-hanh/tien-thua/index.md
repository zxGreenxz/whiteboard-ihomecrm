---
title: "Tiền thừa"
description: "Hiểu giới hạn của báo cáo tiền thừa legacy và đối chiếu với số dư tín dụng khách hàng chuẩn."
routes: ["/reports/finance/overpayment"]
permissions: [{module: reports_finance, action: overpayment}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Tiền thừa

Báo cáo này hiển thị các hóa đơn có `paid_amount - total_amount > 0`. Route cần quyền riêng `reports_finance.overpayment`.

![Báo cáo Tiền thừa với bộ lọc và bảng kết quả](./images/buoc-01-man-hinh.webp)

::: warning Đây là báo cáo legacy
Số trên màn là phần thu vượt còn nằm trên bản ghi hóa đơn. Nó **không phải** số dư tín dụng khách hàng canonical và không theo dõi đầy đủ việc credit đã được tạo, cấn trừ hay còn lại.
:::

## Nguồn credit chuẩn

Credit khách hàng hiện được theo dõi bằng các lot trong `customer_credit_lots`; số dư còn lại là `remaining_amount` và được truy vấn qua `get_customer_credit_balance_v1`.

Vì vậy:

- Một dòng có trên báo cáo cho biết hóa đơn legacy đang có `paid_amount` lớn hơn tổng.
- Không thấy dòng **không có nghĩa** credit đã được dùng hết.
- Không dùng tổng của báo cáo này để cam kết số tiền khách còn được cấn trừ.
- Trước khi cấn, hoàn hoặc giải thích cho khách, phải kiểm tra balance credit chuẩn trong luồng nghiệp vụ có dùng `get_customer_credit_balance_v1`.

## Bộ lọc hiện tại

Bộ lọc tòa có thể được áp dụng trên danh sách. Bộ lọc phòng hiện chỉ là control giữ chỗ và chưa thực sự lọc dữ liệu; không dùng nó để kết luận một phòng không có tiền thừa.

## Khi cần xử lý

1. Xác định khách/hợp đồng và hóa đơn nguồn.
2. Kiểm tra credit lots còn lại.
3. Đối chiếu các lần cấn trừ hoặc hoàn tác liên quan.
4. Chỉ thực hiện nghiệp vụ tiếp theo từ luồng hỗ trợ credit chuẩn; không sửa trực tiếp `paid_amount`.

## Quy trình liên quan

- [Thu tiền tại hóa đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)
- [Chi tiết hóa đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/)
- [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/)
