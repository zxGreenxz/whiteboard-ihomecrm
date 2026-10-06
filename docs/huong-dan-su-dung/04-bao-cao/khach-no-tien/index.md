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
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Khách nợ tiền (đã chuyển)

Báo cáo **Khách nợ tiền** đã bỏ. Đường dẫn `/reports/finance/customer-debt` hiện chuyển thẳng sang màn **Thu tiền** (`/thu-tien`); hai đường dẫn cũ khác là `/reports/finance/debt` và `/report/finance/debt` cũng chuyển về cùng chỗ. Đã kiểm ngày 07/10/2026 trên production: mở đường dẫn cũ sẽ vào thẳng màn Thu tiền.

## Nơi làm việc hiện hành

Dùng [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/) để lọc theo toà/kỳ, xem hoá đơn còn phải thu và ghi nhận thu. Màn đích cần quyền **Vào trang Thu tiền** (`thu_tien.view`); các nút thu, báo cáo và hoàn tác có quyền riêng.

Nếu cần danh sách hoá đơn chi tiết theo kỳ/trạng thái, dùng [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).
