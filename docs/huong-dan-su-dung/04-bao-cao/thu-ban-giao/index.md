---
title: "Báo cáo: Chu kỳ Thu → Bàn giao"
description: "Theo dõi số đã thu, đã bàn giao và công nợ theo mốc của người quản lý trong phạm vi được cấp."
routes: ["/reports/finance/thu-ban-giao"]
permissions: [{module: reports_finance, action: collection_cycle}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Chu kỳ Thu → Bàn giao

Báo cáo dùng RPC `manager_collection_cycle_report` để tổng hợp hoạt động thu, các mốc bàn giao và công nợ point-in-time theo người quản lý/phạm vi tòa.

::: info Quyền riêng bắt buộc
Route yêu cầu đúng `reports_finance.collection_cycle`. Quyền thu tiền như `invoices.record_payment` hoặc `thu_tien.collect` không phải fallback để mở báo cáo này.
:::

![Màn hình báo cáo Chu kỳ Thu → Bàn giao](./images/buoc-01-man-hinh.webp)

## Cách đọc

| Chỉ số | Ý nghĩa |
| --- | --- |
| Đã thu trong kỳ | Số thu hóa đơn thuộc phạm vi/người quản lý trong khoảng chọn. |
| Đã bàn giao trong kỳ | Tổng các nghiệp vụ bàn giao được báo cáo ghi nhận trong khoảng. |
| Chưa thu hiện tại | Công nợ point-in-time trên các hóa đơn thuộc phạm vi. |
| Mốc bàn giao | Timeline giữa các lần bàn giao, kèm số thu trong đoạn và snapshot công nợ. |

Người dùng thường chỉ xem dữ liệu của chính mình; quyền và kiểm tra server quyết định ai có thể chọn người quản lý khác.

## Không dùng chênh lệch làm tồn quỹ chính xác

::: warning “Đã thu − Đã bàn giao” chỉ là chỉ báo chu kỳ
Chênh lệch này không nhất thiết bằng tiền người thu đang giữ. Chuyển nội bộ, movement khác, sổ ảo và ranh giới kỳ có thể làm hai số khác balance của sổ. Muốn biết số dư chính xác, dùng [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/) hoặc báo cáo settlement/cashbook phù hợp.
:::

Tương tự, công nợ tại mốc là snapshot hóa đơn, không phải movement tiền của riêng đoạn đó.

## Đối chiếu

1. Chọn đúng khoảng ngày và người quản lý.
2. Kiểm tra các mốc bàn giao và số thu trong từng đoạn.
3. Mở [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) để xem phiên bàn giao nguồn.
4. Mở [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/) để xác nhận balance as-of.
5. Mở danh sách hóa đơn/Thu tiền để truy các khoản còn nợ.

## Quy trình liên quan

- [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/)
- [Bàn giao tiền & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/)
- [Sổ quỹ theo ngày](/04-bao-cao/so-quy-ngay/)
- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/)
