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
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Công nợ hợp đồng mới (đã chuyển)

`/reports/finance/new-contract-debt` hiện chỉ là một lệnh chuyển hướng thẳng tới `/thu-tien`. Không còn màn hình, bảng số liệu hay file xuất riêng cho báo cáo cũ. Đã kiểm ngày 07/10/2026 trên production: mở đường dẫn cũ sẽ vào thẳng màn **Thu tiền**.

## Nơi làm việc hiện hành

Màn đích `/thu-tien` cần quyền **Vào trang Thu tiền** (`thu_tien.view`). Các hành động tại đó có quyền riêng:

- Thu đủ / thu một phần: `thu_tien.collect`.
- Xem báo cáo thu tiền: `thu_tien.report`.
- Hoàn tác phiếu thu: `thu_tien.undo`.

Dùng [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/) để lọc theo toà/kỳ và xem hoá đơn còn phải thu. Khi cần chi tiết từng hoá đơn, mở [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).

::: warning Không đối chiếu theo tài liệu/báo cáo cũ
Bookmark cũ vẫn hoạt động nhờ chuyển hướng, nhưng không nên mô tả các cột, chỉ số hoặc nguồn dữ liệu của báo cáo đã gỡ như thể chúng còn tồn tại.
:::
