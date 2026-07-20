# Zalo CRM

> **Current through:** 2026-07-20  
> **Canonical plan:** [PLAN.md](PLAN.md)

## Hiện trạng

- CRM hỗ trợ chat Zalo cá nhân hai chiều tại `/chat-zalo` qua worker Node `zca-js` chạy ngoài Vercel.
- Frontend chỉ đọc/gọi Supabase; worker giữ service-role, xử lý queue gửi, WebSocket tin đến và đồng bộ Realtime.
- Đã có hội thoại, gửi text/media, tải lịch sử, reaction, thu hồi, video, nhãn, mẫu tin, broadcast và Web Push tin mới.
- Module chưa phải Zalo OA chính thức; dùng tài khoản phụ, theo dõi rủi ro khóa tài khoản và anti-spam/băng thông trong plan.
- Liên kết customer/lead/contract còn là hướng mở rộng, không giả định đã tự ghép dữ liệu.

## Vận hành

- [ZALO-WORKER-SETUP.md](ZALO-WORKER-SETUP.md) — cài đặt, env, PM2 và xử lý sự cố worker.
- [PLAN.md](PLAN.md) — lộ trình Zalo + AI chăm sóc khách hàng, governance và tranche tiếp theo.
- [../he-thong/18-zalo-chat.md](../he-thong/18-zalo-chat.md) — schema/flow hiện hành.

Nội dung đúng còn lại từ file implementation-status cũ đã được hợp nhất tại đây; không tạo thêm status song song.
