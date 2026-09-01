# Zalo CRM

> **Current through:** 2026-09-02  
> **Nguồn hiện hành (schema/flow/RPC):** [../he-thong/18-zalo-chat.md](../he-thong/18-zalo-chat.md) — file này chỉ là index vận hành.
> **Canonical plan:** [PLAN.md](PLAN.md)

## Hiện trạng

- CRM hỗ trợ chat Zalo cá nhân hai chiều tại `/chat-zalo` qua worker Node `zca-js` chạy ngoài Vercel. Từ 13/08/2026: **ORG-SCOPED toàn tuyến** (mỗi công ty một khu riêng, quyền v3), gửi **media/voice/sticker** từ web, reply quote thật, gắn hội thoại ↔ CRM theo SĐT. Từ 31/08/2026: **automation** (`zalo_automations` + nhật ký `zalo_automation_runs`) đã lên web — worker phải tự cập nhật (`npm install` + `npm run setup`) thì engine mới chạy.
- Frontend chỉ đọc/gọi Supabase; worker giữ service-role, poll queue gửi mỗi 2 giây, nghe WebSocket tin đến và đồng bộ qua Realtime.
- Media hiện chỉ ở chiều **nhận/render**: worker nhận ảnh/video, lưu URL CDN Zalo và frontend hiển thị; ảnh/file/voice từ web chưa có handler gửi dù schema và icon UI đã chừa chỗ.
- Đã có hội thoại, tải lịch sử nhóm, reaction, thu hồi, nhãn, mẫu tin, broadcast text và Web Push tin mới.
- Module chưa phải Zalo OA chính thức; dùng tài khoản phụ, theo dõi rủi ro khóa tài khoản và anti-spam/băng thông trong plan.
- Liên kết customer/lead/contract còn là hướng mở rộng, không giả định đã tự ghép dữ liệu.

## Rủi ro vận hành hiện tại

- Worker giữ `SUPABASE_SERVICE_ROLE_KEY`, có thể bypass RLS; nếu VPS/process bị chiếm quyền thì phạm vi ảnh hưởng không chỉ riêng Zalo.
- Session Zalo `{cookie, imei, userAgent}` lưu trong `worker/sessions/` **mã hoá AES-256-GCM** (key `ZALO_SESSION_KEY` — worker TỪ CHỐI chạy khi thiếu); thư mục đã gitignore 02/09/2026. Vẫn phải giới hạn quyền file và xoay phiên nếu nghi lộ.
- Polling 2 giây tạo tải DB/độ trễ nền và worker đang là thành phần đặc quyền tin cậy. Theo dõi queue `queued/processing/failed`, chỉ giữ một listener cho mỗi nick và không coi polling là bảo đảm giao nhận tức thời.

## Vận hành

- [ZALO-WORKER-SETUP.md](ZALO-WORKER-SETUP.md) — cài đặt, env, PM2 và xử lý sự cố worker.
- [PLAN.md](PLAN.md) — lộ trình Zalo + AI chăm sóc khách hàng, governance và tranche tiếp theo.
- [../he-thong/18-zalo-chat.md](../he-thong/18-zalo-chat.md) — schema/flow hiện hành.

Nội dung đúng còn lại từ file implementation-status cũ đã được hợp nhất tại đây; không tạo thêm status song song.
