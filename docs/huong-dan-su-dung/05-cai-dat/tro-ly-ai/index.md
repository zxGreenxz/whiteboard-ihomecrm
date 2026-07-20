---
title: "Trợ lý AI"
description: "Cách mở AI Copilot, chọn model, dùng công cụ nghiệp vụ và hiểu các giới hạn an toàn."
routes: ["/settings/ai-copilot"]
permissions: [{module: ai_copilot, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-20"
  account: production
status: published
---

# Trợ lý AI

AI Copilot xuất hiện dưới dạng nút nổi khi tài khoản có entitlement và quyền sử dụng. Bạn có thể hỏi bằng tiếng Việt về phòng trống, khách hàng, hóa đơn, hợp đồng sắp hết hạn, KQKD và cách dùng hệ thống.

## Cách dùng

1. Bấm nút nổi **AI Copilot** ở góc phải màn hình.
2. Chọn model được quản trị viên cho phép.
3. Viết yêu cầu có phạm vi rõ: tòa, tháng, trạng thái hoặc tên khách.
4. Kiểm tra link/kết quả trước khi hành động.

## Điều khiển giao diện

Chế độ UI-control chỉ hoạt động khi tài khoản được cấp riêng. Copilot chỉ điều hướng và lọc trên route cho phép; mỗi lệnh là một phiên độc lập và vẫn chịu gate quyền của tài khoản.

## Tạo phiếu nháp

Copilot có thể chuẩn bị phiếu thu/chi nháp. Quy trình bắt buộc:

1. Copilot đưa bản xem trước.
2. Bạn xác nhận rõ ràng.
3. Hệ thống tạo **nháp**, chưa gắn sổ và chưa tác động tiền.
4. Người có trách nhiệm kiểm tra/duyệt tại màn Thu chi hoặc [Chờ duyệt](/03-quan-ly-van-hanh/cho-duyet/).

::: warning
AI không thay thế người duyệt, không vượt RLS và không nên được cung cấp mật khẩu, token, CCCD hoặc thông tin ngân hàng không cần thiết.
:::

::: info Xem kế hoạch phát triển AI
Mở [bản trình bày AI Copilot](/08-ke-hoach-phat-trien/ai-copilot/) để xem mục tiêu doanh nghiệp, quy trình tương lai, lộ trình, rủi ro và phụ lục kỹ thuật của hệ thống AI.
:::
