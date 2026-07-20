# Zalo CRM

> **Current through:** 2026-07-20  
> **Canonical plan:** [PLAN.md](PLAN.md)

## Hiện trạng

- CRM hỗ trợ chat Zalo cá nhân hai chiều tại `/chat-zalo` qua worker Node `zca-js` chạy ngoài Vercel; chiều gửi từ web hiện chỉ hỗ trợ **text/reply** và broadcast text.
- Frontend chỉ đọc/gọi Supabase; worker giữ service-role, poll queue gửi mỗi 2 giây, nghe WebSocket tin đến và đồng bộ qua Realtime.
- Media hiện chỉ ở chiều **nhận/render**: worker nhận ảnh/video, lưu URL CDN Zalo và frontend hiển thị; ảnh/file/voice từ web chưa có handler gửi dù schema và icon UI đã chừa chỗ.
- Đã có hội thoại, tải lịch sử nhóm, reaction, thu hồi, nhãn, mẫu tin, broadcast text và Web Push tin mới.
- Module chưa phải Zalo OA chính thức; dùng tài khoản phụ, theo dõi rủi ro khóa tài khoản và anti-spam/băng thông trong plan.
- Liên kết customer/lead/contract còn là hướng mở rộng, không giả định đã tự ghép dữ liệu.

## Rủi ro vận hành hiện tại

- Worker giữ `SUPABASE_SERVICE_ROLE_KEY`, có thể bypass RLS; nếu VPS/process bị chiếm quyền thì phạm vi ảnh hưởng không chỉ riêng Zalo.
- Session Zalo `{cookie, imei, userAgent}` được lưu JSON không mã hoá trong `worker/sessions/`; phải giới hạn quyền file, backup/log và xoay phiên nếu lộ.
- Polling 2 giây tạo tải DB/độ trễ nền và worker đang là thành phần đặc quyền tin cậy. Theo dõi queue `queued/processing/failed`, chỉ giữ một listener cho mỗi nick và không coi polling là bảo đảm giao nhận tức thời.

## Vận hành

- [ZALO-WORKER-SETUP.md](ZALO-WORKER-SETUP.md) — cài đặt, env, PM2 và xử lý sự cố worker.
- [PLAN.md](PLAN.md) — lộ trình Zalo + AI chăm sóc khách hàng, governance và tranche tiếp theo.
- [../he-thong/18-zalo-chat.md](../he-thong/18-zalo-chat.md) — schema/flow hiện hành.

Nội dung đúng còn lại từ file implementation-status cũ đã được hợp nhất tại đây; không tạo thêm status song song.
