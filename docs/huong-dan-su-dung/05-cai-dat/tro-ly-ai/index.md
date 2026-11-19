---
title: "Kết nối Hermes"
description: "Kết nối tài khoản CRM với nick Zalo của bạn để nhắn riêng cho bot Hermes của công ty."
routes: ["/settings/hermes"]
permissions: []
viewport: responsive
audience: [chu-nha, quan-ly-toa, ke-toan]
status: published
---

# Kết nối Hermes

Trong CRM, mở **Cài đặt hệ thống → Kết nối Hermes** (`/settings/hermes`). Đây là nơi bạn cấp quyền và liên kết nick Zalo. Sau khi kích hoạt, bạn nhắn riêng cho bot của công ty trên Zalo. Khung chat Copilot trước đây trên web đã được gỡ.

## Kết nối lần đầu

1. Đăng nhập CRM và chọn đúng [công ty làm việc](/06-tai-khoan/thong-tin-ca-nhan/). Công ty cần bật Hermes và có bot Zalo sẵn sàng. Nếu thiếu một trong hai, nhờ quản trị công ty hoàn tất bước đầu trên trang.
2. Trong **Cài đặt & kết nối**, chọn **Bắt đầu kết nối**. Hermes dùng quyền CRM của bạn trong công ty này. Nếu muốn giới hạn thêm quyền hoặc các tòa nhà, mở **Tuỳ chỉnh quyền (không bắt buộc)**. Nhập mật khẩu vào ô **Xác nhận mật khẩu CRM**, rồi bấm **Tạo kết nối**. Nếu đã có kết nối còn dùng được, tiếp tục với kết nối đó.
3. Mở **Liên kết Zalo để nhắn Hermes**. Chọn bot của công ty nếu có nhiều bot, rồi bấm **Tạo mã liên kết Zalo**.
4. Dùng nick Zalo chính của bạn nhắn riêng cho bot đã chọn. Chỉ sao chép phần **Nội dung gửi cho bot** bằng nút **Sao chép mã Zalo**. Giữ riêng mật khẩu CRM và **Mã kết nối** trong mục nâng cao dành cho người tự chạy Hermes.
5. Quay lại CRM. Khi bot đã nhận tin, kiểm tra UID của nick Zalo hiển thị. Nếu đúng nick của mình, bấm **Ghép nick Zalo này**. Khi bước **Trợ lý được kích hoạt** báo hoàn tất, bạn có thể nhắn cho bot.

## Sử dụng và ngắt kết nối

Bạn có thể hỏi “Tòa nhà A còn phòng nào trống?” hoặc “Việc nào của tôi sắp quá hạn?”. Kết quả phụ thuộc vào công ty và quyền bạn đã cấp.

Nếu mã Zalo đã hết hạn, tạo mã mới rồi gửi lại cho đúng bot. Để thu hồi quyền truy cập CRM của kết nối, chọn **Ngắt kết nối** và xác nhận trên trang Hermes.
