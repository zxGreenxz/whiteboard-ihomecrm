---
title: "Công nợ hợp đồng mới (đã chuyển)"
description: "Route báo cáo cũ chuyển sang màn Thu tiền hiện hành; không còn report riêng để đọc."
kind: redirect
lifecycle: current
sidebar: false
routes: ["/reports/finance/new-contract-debt"]
redirect_to: "/thu-tien"
permissions: [{module: thu_tien, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-20"
  account: production
status: published
---

# Công nợ hợp đồng mới (đã chuyển)

`/reports/finance/new-contract-debt` hiện là một `Navigate` redirect thẳng tới `/thu-tien`. Không có component, truy vấn, bảng số liệu hay file xuất riêng cho báo cáo cũ.

## Nơi làm việc hiện hành

Route đích `/thu-tien` cần quyền `thu_tien.view`. Các hành động tại đó có quyền riêng:

- Ghi nhận thu: `thu_tien.collect`.
- Xem báo cáo thu: `thu_tien.report`.
- Hoàn tác: `thu_tien.undo`.

Dùng [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/) để lọc theo tòa/kỳ và xem hóa đơn còn phải thu. Khi cần chi tiết từng hóa đơn, mở [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).

::: warning Không đối chiếu theo tài liệu/report cũ
Bookmark cũ vẫn hoạt động nhờ redirect, nhưng không nên mô tả các cột, KPI hoặc nguồn dữ liệu của báo cáo đã bị gỡ như thể chúng còn tồn tại.
:::
