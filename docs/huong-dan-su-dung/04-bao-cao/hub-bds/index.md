---
title: "Báo cáo bất động sản (tổng quan)"
description: "Điểm vào đúng tám báo cáo BĐS hiện hành, mỗi báo cáo có quyền action riêng."
routes: ["/reports/real-estate"]
permissions: [{module: reports_real_estate, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "c6e8e4584b0a43a543ac0dd296f49c53f7e85d6b"
  account: demo.chunha
status: published
---

# Báo cáo bất động sản

Hub `/reports/real-estate` là lưới điều hướng, không tự tính số liệu. Route hub cần `reports_real_estate.view`; mỗi thẻ đích tiếp tục được route guard bằng action riêng.

![Hub Báo cáo Bất động sản production hiển thị đủ 8 loại báo cáo](./images/buoc-01-man-hinh.webp)

## Đúng tám báo cáo và quyền

| Báo cáo | Route chính | Action |
| --- | --- | --- |
| Căn hộ trống | `/reports/real-estate/vacant-rooms` | `vacant_rooms` |
| Căn hộ sắp trống | `/reports/real-estate/expiring-contracts` | `expiring` |
| Gia hạn & chuyển nhượng | `/reports/real-estate/renewals-transfers` | `renewals_transfers` |
| Tỉ lệ lấp đầy | `/reports/real-estate/occupancy` | `occupancy` |
| Khuyến mại | `/reports/real-estate/promotions` | `promotions` |
| Cho thuê mới | `/reports/real-estate/new-leases` | `new_leases` |
| Bỏ trả / thanh lý | `/reports/real-estate/terminations` | `terminations` |
| Tỉ lệ chi phí / doanh thu | `/reports/real-estate/expense-ratio` | `expense_ratio` |

Các alias `/reports/real-estate/vacant` và `/reports/real-estate/expiring` mở cùng component với route chính. `/reports/real-estate/occupancy-new` chỉ redirect về `/reports/real-estate/occupancy`.

::: warning Hub không lọc thẻ theo quyền action
Component hub hiện render đủ tám thẻ. Nếu tài khoản có quyền vào hub nhưng thiếu action của một báo cáo, bấm thẻ đó sẽ bị route guard chặn. Không dùng việc “thấy thẻ” để kết luận đã được cấp quyền xem dữ liệu.
:::

## Chọn báo cáo theo câu hỏi

- Cần danh sách có thể cho thuê ngay: **Căn hộ trống**.
- Cần dự báo hợp đồng gần hết hạn: **Căn hộ sắp trống** hoặc phần sắp trống 30/60 ngày trong **Tỉ lệ lấp đầy**.
- Cần nhìn snapshot năm trạng thái, trend và doanh thu bỏ lỡ: **Tỉ lệ lấp đầy**.
- Cần theo dõi khách vào/ra: đối chiếu **Cho thuê mới** với **Bỏ trả / thanh lý**.
- Cần truy ưu đãi đã lưu trên hợp đồng: **Khuyến mại**.
- Cần so chi đã duyệt với thu đã duyệt: **Tỉ lệ chi phí / doanh thu**.

## Giới hạn phạm vi

Các route yêu cầu quyền ứng dụng; dữ liệu phía sau còn chịu RLS/phạm vi tổ chức và tòa. Một bảng rỗng có thể do không có dữ liệu trong bộ lọc hoặc tài khoản không thấy bản ghi ngoài phạm vi, không chứng minh toàn tổ chức không có dữ liệu.

## Quy trình liên quan

- [Phòng trống](/04-bao-cao/phong-trong/)
- [Hợp đồng sắp hết hạn](/04-bao-cao/hd-sap-het-han/)
- [Tỷ lệ lấp đầy](/04-bao-cao/lap-day/)
- [Thanh lý / bỏ trả](/04-bao-cao/thanh-ly/)
