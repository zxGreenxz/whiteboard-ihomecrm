---
title: "Báo cáo: Lịch thanh toán"
description: "Theo dõi hạn hóa đơn theo phòng và hiểu các giới hạn hiện tại của bộ lọc, phạm vi thời gian và số dòng."
routes: ["/reports/finance/payment-schedule"]
permissions: [{module: reports_finance, action: payment_schedule}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Lịch thanh toán

Route cần quyền `reports_finance.payment_schedule`. Báo cáo hỗ trợ rà các hạn hóa đơn theo phòng, nhưng không phải lịch phát hành canonical và hiện có một số giới hạn cần biết.

![Màn hình báo cáo Lịch thanh toán](./images/buoc-01-man-hinh.webp)

## Cách đọc

- Dữ liệu lấy các hóa đơn có `due_date` đến **hôm nay + 365 ngày**.
- Các dòng được nhóm theo phòng; ngày đại diện là **hạn lớn nhất** trong nhóm.
- Dùng báo cáo để tìm phòng cần rà tiếp, rồi mở danh sách/chi tiết hóa đơn để quyết định nghiệp vụ.

## Giới hạn hiện tại

::: warning Không dùng làm danh sách đầy đủ tuyệt đối
- Truy vấn hiện chưa loại hóa đơn đã hủy hoặc bị xóa.
- Truy vấn chưa phân trang nên có thể bị giới hạn ở 1.000 dòng.
- Bộ lọc phòng trên giao diện hiện không thực sự lọc kết quả.
- Một phòng có nhiều hóa đơn sẽ hiển thị theo ngày đến hạn lớn nhất, có thể che một hóa đơn cũ hơn cần xử lý.
:::

Vì vậy, không kết luận “không có hóa đơn” chỉ vì báo cáo không hiện dòng. Hãy kiểm tra [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) với bộ lọc hợp đồng, kỳ và trạng thái.

## Cách sử dụng an toàn

1. Lọc tòa/phạm vi hỗ trợ nếu có.
2. Ghi nhận các phòng có hạn cần chú ý.
3. Mở danh sách hóa đơn để loại trạng thái hủy/xóa và xem từng kỳ.
4. Chỉ tạo hóa đơn mới sau khi chắc chắn kỳ tương ứng chưa tồn tại.

## Quy trình liên quan

- [Hoá đơn — danh sách & tạo lẻ](/03-quan-ly-van-hanh/hoa-don/)
- [Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/sinh-hoa-don/)
- [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/)
