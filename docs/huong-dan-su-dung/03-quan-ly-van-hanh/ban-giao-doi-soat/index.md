---
title: "Bàn giao tiền & đối soát"
description: "Ghi nhận các phiên bàn giao, so số đếm thực tế với số hệ thống tại một thời điểm và phân biệt đối soát với đóng sổ."
routes: ["/reports/finance/ban-giao"]
permissions: [{module: reports_finance, action: handover_report}]
viewport: desktop
audience: [ke-toan, chu-nha]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Bàn giao tiền & đối soát

Trang này theo dõi việc bàn giao tiền và ghi nhận một lần đối chiếu số quỹ **tại thời điểm được chọn**. Route yêu cầu riêng quyền `reports_finance.handover_report`.

![Màn Bàn giao & đối soát với bộ lọc và danh sách sổ quỹ](./images/buoc-01-man-hinh.webp)

## Thực hiện đối soát

**Bước 1**: Chọn khoảng thời gian, người bàn giao/nhận và sổ quỹ cần kiểm tra theo các trường hệ thống cung cấp.

**Bước 2**: Đối chiếu số hệ thống **as-of** với tiền hoặc chứng từ thực tế đang đếm.

**Bước 3**: Nhập số kiểm đếm, ghi chú chênh lệch và xác nhận phiên theo quy trình của tổ chức.

**Bước 4**: Sau khi lưu, kiểm tra lại mốc thời gian, các bên tham gia và số chênh lệch. Một phiên có thể là một bên hoặc có bên đối tác tùy dữ liệu và luồng đang dùng; không mặc định mọi phiên đều là biên bản hai phía.

## Đối soát không phải đóng sổ

::: warning Phiên đối soát không khóa sổ
Nghiệp vụ tại `/reports/finance/ban-giao` chỉ lưu một snapshot so sánh số hệ thống và số đếm. Các giao dịch sau đó vẫn có thể phát sinh. Muốn đóng sổ vĩnh viễn phải thực hiện tại [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) với người xác nhận khác và điều kiện quyền riêng.
:::

Không dùng khái niệm “mở khóa” cho phiên đối soát: trang này không đặt khóa sổ ngay từ đầu.

## Cách đọc “còn phải nộp”

Số bàn giao là một chỉ báo theo nghiệp vụ và phạm vi được chọn. Khi cần biết tồn chính xác của một sổ, dùng báo cáo posting-aware [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/) và đối chiếu POSTING/REVERSAL. Các chuyển nội bộ, sổ ảo hoặc ranh giới kỳ có thể làm phép trừ đơn giản giữa “đã thu” và “đã bàn giao” khác số tiền mặt thực giữ.

## Quy trình liên quan

- [Chu kỳ Thu → Bàn giao](/04-bao-cao/thu-ban-giao/)
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
- [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/)
- [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/)
