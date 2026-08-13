---
title: "Báo cáo tài chính (tổng quan)"
description: "Trung tâm 10 báo cáo tài chính đang hiển thị trên production, gồm Trung tâm Tài chính & Hiệu quả và chín báo cáo nghiệp vụ."
routes: ["/reports/finance"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "c6e8e4584b0a43a543ac0dd296f49c53f7e85d6b"
  account: demo.chunha
status: published
---

# Báo cáo tài chính

Hub `/reports/finance` trên deployment production được kiểm tra ngày 13/08/2026 hiển thị **10 loại báo cáo**. Mỗi thẻ báo cáo còn có action quyền riêng; mở được hub không đồng nghĩa mở được mọi báo cáo.

![Hub Báo cáo Tài chính của tài khoản demo.chunha hiển thị 10 loại báo cáo và mục OpenClaw Zalo trên sidebar production](./images/buoc-01-man-hinh.webp)

## 10 thẻ đang hiển thị

1. Trung tâm Tài chính & Hiệu quả
2. Phân tích tài chính (`analysis`)
3. Bàn giao tiền & Đối soát sổ (`handover_report`)
4. Chu kỳ Thu → Bàn giao (`collection_cycle`)
5. Sổ quỹ theo ngày (`daily_cashbook`)
6. Dòng tiền (`cash_flow`)
7. Báo cáo Lợi nhuận (`profit_distribution` và quyền tab liên quan)
8. Lịch thanh toán (`payment_schedule`)
9. Tiền thừa (`overpayment`)
10. Danh sách tiền cọc (`deposits_report`)

::: info Runtime đã kiểm tra
Ảnh trên là production với tổ chức DEMO và tài khoản `demo.chunha`; thẻ **Trung tâm Tài chính & Hiệu quả** đang được hiển thị. Ở tổ chức hoặc vai trò khác, thẻ có thể bị ẩn bởi điều kiện tổ chức/quyền riêng của route.
:::

## Chọn báo cáo đúng câu hỏi

- Muốn biết tiền đã vào/ra: dùng **Dòng tiền** hoặc **Sổ quỹ theo ngày**.
- Muốn biết lãi/lỗ: dùng **Phân tích tài chính**.
- Muốn kiểm tra cọc: ưu tiên luồng **Đặt cọc**; báo cáo danh sách cọc hiện là legacy.
- Muốn xem credit khách còn lại: không dùng **Tiền thừa** làm nguồn canonical.
- Muốn đối chiếu người đi thu/nộp: dùng **Chu kỳ Thu → Bàn giao**, rồi kiểm tra sổ quỹ để biết balance chính xác.
