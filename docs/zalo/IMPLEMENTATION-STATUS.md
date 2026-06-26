# Chat Zalo — Trạng thái triển khai (rà theo docs/zalo)

> Bản đồ tính năng: phần nào ĐÃ XONG, phần nào CÒN THIẾU. Các tài liệu khác trong
> thư mục này (ZALO-INTEGRATION, ZALO-CHAT-BUILD-SPEC, …) là **tham khảo ý tưởng**
> từ n2store cũ — repo này làm **Supabase-native** (Vercel + Supabase) + **worker
> zca-js** (local→VPS), KHÔNG dùng lại backend đó.

Ngày cập nhật: 2026-06-26. Tài khoản thật đã kết nối & verify: **Nguyễn Tâm**
(đồng bộ 1470 bạn + 354 nhóm; nhận tin live OK).

## ✅ ĐÃ XONG (P0 + nền tảng)

| Tính năng | Nơi | Ghi chú |
|---|---|---|
| Trang Chat Zalo 3 cột (danh sách · chat · panel) | `src/pages/chat-zalo`, `src/components/chat-zalo/*` | đúng design |
| Kết nối tài khoản cá nhân bằng **QR** (zca-js) | `worker/index.js`, `ConnectZaloDialog`, RPC `zalo_request_connect` | đã quét & đăng nhập thật |
| **Đồng bộ DANH BẠ + NHÓM** về hội thoại khi đăng nhập | `worker/index.js` `syncContacts()` (`getAllFriends`/`getAllGroups`/`getGroupInfo`) | "lấy toàn bộ về" |
| **Avatar thật** (no-referrer + fallback chữ) | `ZaloAvatar.tsx` | dùng ở list/header/panel |
| Nhận tin **inbound realtime** | worker `listener.on('message')` → DB → Supabase Realtime | đã thấy tin nhóm về live |
| Gửi **text** (tới bạn/nhóm thật) | RPC `zalo_send_message` → `zalo_send_queue` → worker `api.sendMessage` | hàng đợi + optimistic |
| Re-login từ cookie (khỏi quét lại) | worker `tryRelogin()` + `sessions/<id>.json` | |
| Đa tài khoản + chuyển/ngắt kết nối | `AccountSwitcher.tsx`, RPC connect/disconnect | |
| Đã đọc / chưa đọc (đếm + mark_read) | RPC `zalo_mark_read`, unread_count | |
| Tự động hoá (toggle) + mẫu tin | `AutomationPanel`, `zalo_automations`, `zalo_message_templates` | UI + lưu DB |
| Inbound **reaction / thu hồi / seen** (best-effort) | worker `handleReaction/handleUndo/handleSeen` | cập nhật DB khi đối phương thao tác |

## 🟡 LÀM SAU (theo yêu cầu — "bộ lọc tôi sẽ làm sau")

| Tính năng | Gợi ý triển khai | zca-js |
|---|---|---|
| **Bộ lọc / phân loại hội thoại** (Chưa đọc, Khách trọ, Lead, theo khu…) | Chip lọc đã có khung; thêm logic phân loại + tìm kiếm server-side cho >1000 | — |
| Tách "Danh bạ" vs "Hội thoại gần đây" | Hiện đang đổ chung ~1829 contact vào list (cap render 300) | — |
| Phân trang/ảo hoá danh sách lớn | react-virtual cho list khi vài nghìn dòng | — |

## 🔧 CÒN THIẾU — Tính năng chat nâng cao (P1/P2, chưa làm)

| # | Tính năng | Cần gì | zca-js |
|---|---|---|---|
| 1 | Gửi **ảnh / file** | UI upload + Storage/bytea → worker `processJob` nhánh media | `uploadAttachment` → `sendMessage({attachments})` |
| 2 | Gửi **sticker** | UI picker → route gửi | `sendSticker`, `getStickers` |
| 3 | **Thả reaction** từ web | Menu chuột phải bong bóng + RPC + queue | `addReaction` (chỉ thêm, không gỡ) |
| 4 | **Thu hồi** tin mình gửi | Menu + RPC (cần `cli_msg_id` — đã lưu) | `undo` |
| 5 | **Chỉ báo đang gõ** (typing) | Kênh broadcast Supabase (transient) + worker `listener.on('typing')` | `sendTypingEvent` |
| 6 | **Tải tin cũ** (chỉ NHÓM) | Nút "Tải thêm" + worker | `getGroupChatHistory` (1-1 KHÔNG có API) |
| 7 | @mention trong nhóm | Autocomplete thành viên | `getGroupMembersInfo`, `sendMessage({mentions})` |
| 8 | Ghim / tắt thông báo / đánh dấu chưa đọc | Menu hội thoại + RPC | `setPinnedConversations`, `setMute`, `addUnreadMark` |
| 9 | Chuyển tiếp / xoá-phía-tôi / voice / video | UI + worker | `forwardMessage`, `deleteMessage`, `sendVoice`, `sendVideo` |
| 10 | OA / ZNS (chính thức) | Edge Function serverless (không VPS) | OA API |

## ⚠️ Giới hạn kỹ thuật (theo docs)
- **Không backfill lịch sử 1-1** (zca-js không hỗ trợ) — chỉ nhóm có `getGroupChatHistory`.
- **Reaction chỉ thêm**, không gỡ.
- 1 listener / nick: đừng mở Zalo Web nơi khác cùng tài khoản worker (bị kick 3000/3003) → worker tự re-login từ cookie.
- Watchdog re-login chủ động trước khi cookie hết hạn (~ vài ngày) là việc nên thêm khi lên VPS.

## Vận hành
- Worker: `cd worker && npm start` (đã có `.env`). Lên VPS: pm2/systemd — xem `ZALO-WORKER-SETUP.md`.
- Seed demo (`scripts/seed-zalo-demo.mjs`) tạo 5 hội thoại mẫu thuộc tài khoản "Zalo cá nhân (demo)";
  có thể xoá khi đã dùng dữ liệu thật (Ngắt/đổi trong AccountSwitcher hoặc xoá account demo).
