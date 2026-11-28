# Điều phối AI của CRM trên VPS Hermes

Edge chuyển yêu cầu đọc chữ, ảnh và trò chuyện tới `crm-hermes.chillhome.io.vn/ai-gateway`. Gateway chạy bằng user hệ thống `ihome-crm-ai` và chuyển tiếp tới địa chỉ cố định của từng nhà cung cấp. Chép giọng gọi trực tiếp API audio của OpenRouter bằng khóa riêng hiện hành. Worker đồng hồ dùng khóa dịch vụ của nguồn đã chọn. Edge xác minh quyền, hạn mức và ghi nhật ký trước lượt gọi AI.

Kết nối `nous-owner` cần khóa riêng ở Edge và UUID do Supabase Auth xác nhận. Hermes chạy adapter Nous từ cùng image và profile của `hermes-owner`, trên Unix socket chỉ gateway đọc được. OAuth được làm mới bởi adapter. Yêu cầu tới socket chỉ mang dữ liệu suy luận và model. Nguồn AI dùng chung danh mục đã đồng bộ.

## Vận hành

- Cài hai unit trong thư mục này. Thư mục release ở `/opt/ihome-crm-ai/current` trỏ tới mã đã review và thuộc root. Tạo user hệ thống `ihome-crm-ai` và hai file env thuộc root, mode 0600, ở `/etc/ihome-crm-ai`.
- Trong `sidecar.env`, đặt `HERMES_IMAGE` theo image ID của container hiện hành, `OWNER_UID`, `OWNER_GID` theo UID/GID trong container và `PROFILE_DIR` theo đường dẫn profile owner trên host. Đối chiếu lại image khi nâng cấp Hermes.
- Trong `gateway.env`, đặt hai giá trị ngẫu nhiên độc lập `CRM_AI_VPS_KEY` và `CRM_AI_OWNER_CONNECTOR_KEY`. Cấu hình hai giá trị tương ứng ở Supabase Edge. Chỉ worker cần khóa đầu tiên. Đặt `CRM_AI_OWNER_ID` ở Edge theo tài khoản CRM đã đối chiếu với owner.
- Trước khi bật Edge, khởi động hai unit và thêm ingress riêng của tunnel cho `^/ai-gateway/.*$` tới `http://127.0.0.1:18763`, trước catch-all của hostname CRM Hermes. Kiểm ingress, khởi động lại tunnel theo cách triển khai hiện hành. Lượt thiếu khóa phải trả 401. Kiểm `/models` và một yêu cầu ảnh tổng hợp sau khi đồng bộ trên trang Nguồn AI.
- Khi cần hoàn tác, bỏ các biến `CRM_AI_*` vừa thêm ở Edge và worker rồi khôi phục các tuyến đã lưu trước đó. Sau khi xác minh nguồn cũ hoạt động, gỡ riêng ingress và dừng hai unit.
