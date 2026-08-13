---
title: "Khách nợ tiền (đã chuyển)"
description: "Route báo cáo cũ chuyển sang màn Thu tiền hiện hành."
kind: redirect
lifecycle: current
sidebar: false
routes: ["/reports/finance/customer-debt"]
redirect_to: "/thu-tien"
permissions: [{module: thu_tien, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-20"
  account: production
status: published
---

# Khách nợ tiền (đã chuyển)

Đường dẫn `/reports/finance/customer-debt` hiện chuyển thẳng sang `/thu-tien`.

## Nơi làm việc hiện hành

Dùng [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/) để lọc theo tòa/kỳ, xem hóa đơn còn nợ và ghi nhận thu. Route đích cần quyền xem module `thu_tien`; các nút thu, báo cáo và hoàn tác có action riêng.

Nếu cần danh sách hóa đơn chi tiết theo kỳ/trạng thái, dùng [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).
