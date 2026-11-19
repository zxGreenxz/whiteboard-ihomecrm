# Trợ lý Hermes và lịch sử AI Copilot

> **Reviewed:** 2026-11-19

## Trợ lý đang dùng

Người dùng đã đăng nhập mở **Cài đặt hệ thống → Kết nối Hermes** tại `/settings/hermes` và chọn công ty làm việc. Quản trị công ty bật Hermes và cấu hình bot Zalo. Người dùng tạo kết nối theo quyền CRM của mình, có thể thu hẹp quyền hoặc phạm vi tòa nhà, rồi ghép nick Zalo cá nhân với bot.

Sau khi ghép đúng nick và kích hoạt, người dùng nhắn riêng cho bot trên Zalo. Trang CRM quản lý kết nối và cho phép thu hồi quyền. Xem [hướng dẫn Kết nối Hermes](../huong-dan-su-dung/05-cai-dat/tro-ly-ai/index.md).

## Lịch sử Copilot

Trong P11 (PR #171), dự án đã gỡ giao diện chat Copilot và client gọi mô hình. Các thành phần còn được dùng chung hoặc kiểm tra ngoại tuyến được ghi trong [sổ theo dõi mô-đun](../../tooling/deferred-modules.json). Tên tệp chương này được giữ để các liên kết tài liệu cũ vẫn mở được.

Luồng Hermes hiện tại được định nghĩa trong [route cài đặt](../../src/app/routes/settingsRoutes.tsx), [trang Kết nối Hermes](../../src/pages/settings/HermesConnectionsPage.tsx) và [các bước ghép nick Zalo](../../src/hermes/HermesZaloBindings.tsx).
