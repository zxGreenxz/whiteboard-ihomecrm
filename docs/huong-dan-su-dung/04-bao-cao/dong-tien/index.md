---
title: "Báo cáo: Dòng tiền"
description: "Theo dõi tiền thực vào/ra đã post theo tháng hoặc quý và phân biệt cash movement với doanh thu, chi phí, lợi nhuận."
routes: ["/reports/finance/cash-flow"]
permissions: [{module: reports_finance, action: cash_flow}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Báo cáo: Dòng tiền

Route cần quyền `reports_finance.cash_flow`. Báo cáo nhóm các movement tiền đã post theo tháng/quý và hiển thị thu vào, chi ra, chênh lệch.

Snapshot production của `demo.chunha` ngày 13/08/2026, bộ lọc năm **2026** hiển thị toàn bộ **Thu vào / Chi ra / Chênh lệch = 0đ**, kể cả dòng **Cả năm**. Biểu đồ vẫn render đủ trục và chú giải nhưng không có cột phát sinh.

![Màn hình báo cáo Dòng tiền](./images/buoc-01-man-hinh.webp)

## Nguồn số

`cashflow_by_day` dùng tổng hợp Finance V2 posting-aware:

- Tính các event `POSTING` và `REVERSAL` theo dấu tiền.
- Không coi một phiếu chỉ có trạng thái `APPROVED` là đã di chuyển tiền.
- Dùng ngày movement/voucher theo chế độ báo cáo tiền, không phải kỳ ghi nhận doanh thu dồn tích.

## Cách đọc đúng

- **Thu vào** là movement làm tăng sổ quỹ.
- **Chi ra** là movement làm giảm sổ quỹ.
- **Chênh lệch** là dòng tiền ròng trong kỳ lọc.
- Đây không phải báo cáo doanh thu, chi phí hay lợi nhuận.

::: warning Chuyển nội bộ và sổ ảo
Khi không lọc, báo cáo có thể gồm chuyển nội bộ hoặc movement trên sổ ảo. Hai phía của một chuyển khoản nội bộ có thể làm tổng thu/chi phình lên dù tiền toàn tổ chức không đổi. Lọc đúng tòa/sổ và mở chứng từ nguồn trước khi kết luận.
:::

## So với Phân tích tài chính

[Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/) dùng P&L/item-level, mặc định dồn tích và loại cọc. Báo cáo Dòng tiền trả lời **tiền đã đi vào/ra khi nào**; P&L trả lời **doanh thu, chi phí thuộc kỳ nào**. Hai con số không bắt buộc bằng nhau.

## Quy trình liên quan

- [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/)
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/)
- [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/)
- [Bàn giao tiền & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/)
