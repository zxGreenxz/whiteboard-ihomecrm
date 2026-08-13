---
title: "Trợ lý AI"
description: "Phân biệt launcher AI Copilot hiện hành, trang quản trị /settings/ai-copilot và các đề xuất phát triển chưa phải runtime."
routes: ["/settings/ai-copilot"]
permissions: [{module: ai_copilot, action: view}, {module: ai_copilot, action: ui_control}]
viewport: responsive
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-08-13"
  account: production
status: published
---

# Trợ lý AI

AI Copilot hiện có hai bề mặt khác nhau:

- **Launcher nổi** chỉ xuất hiện khi người dùng đã đăng nhập, tổ chức/tài khoản có entitlement và có `ai_copilot.view`.
- `/settings/ai-copilot` là trang quản trị/usage đã đăng nhập. Super admin thấy các khu Settings, Users/Entitlements, Providers và Usage; người dùng thường có entitlement chỉ thấy Usage theo RLS.

Route quản trị không tự dùng `ai_copilot.view` làm route guard. Quyền ghi thật được bảo vệ bởi policy/RLS phía máy chủ; không suy ra quyền quản trị chỉ vì mở được URL.

## Cách dùng launcher hiện hành

1. Bấm nút nổi **AI Copilot** nếu nó xuất hiện.
2. Viết yêu cầu có phạm vi rõ: toà nhà, kỳ, trạng thái hoặc đối tượng cần tra cứu.
3. Kiểm tra nguồn và dữ liệu trả về trước khi thực hiện thao tác nghiệp vụ.
4. Nếu tổ chức không có entitlement hoặc tài khoản thiếu `ai_copilot.view`, launcher sẽ không hiện.

`ai_copilot.ui_control` là quyền experimental riêng. Quyền này không cho AI vượt route guard, RLS hoặc quyền hiệu lực của người dùng.

::: warning Giới hạn an toàn
Không cung cấp mật khẩu, token hoặc dữ liệu nhạy cảm không cần thiết. AI không thay thế người duyệt; mọi kết quả và hành động cần được người có trách nhiệm kiểm tra.
:::

## Tính năng nội bộ đang tắt mặc định

- **OpenClaw Zalo** dùng `VITE_OPENCLAW_ZALO_MODE`, mặc định code là `off`; route chỉ được mount khi runtime bật. Deployment production được kiểm tra ngày 13/08/2026 đang bật và hiển thị mục **OpenClaw Zalo** cho `demo.chunha`, nên phải đọc runtime thực tế thay vì suy từ mặc định local.
- **Network Center** dùng `VITE_NETWORK_CENTER_MODE`, mặc định `off`; route `/network-center/*` chỉ tồn tại khi runtime bật và khi đó cần `network_center.view`.
- Mode `demo` của cả hai bị từ chối trong production build. Có permission không đồng nghĩa tính năng đã được phát hành.

::: info Kế hoạch không phải runtime
Trang [Kế hoạch phát triển AI Copilot](/08-ke-hoach-phat-trien/ai-copilot/) là **PROPOSAL**, dùng để thảo luận lộ trình tương lai. Không dùng nội dung đó để xác nhận tính năng production hiện hành.
:::
