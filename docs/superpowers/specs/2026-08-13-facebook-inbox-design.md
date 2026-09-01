# Thiết kế: Facebook Inbox cho iHome CRM — Graph API chính thức

> **Trạng thái**: đã duyệt thiết kế 2026-08-13 (brainstorming với user).
> **Nguồn tham chiếu**: `docs/superpowers/specs/WEB2-FACEBOOK-FEATURE-SPEC.md` (spec hệ Pancake cũ —
> dùng làm kho "bất biến đã trả giá bằng bug", KHÔNG port nguyên xi) + 3 đợt nghiên cứu tài liệu
> chính thức developers.facebook.com (Graph API v26.0, 08/2026).

---

## 0. Các quyết định đã chốt với user

| # | Quyết định | Chọn |
|---|---|---|
| 1 | Phạm vi | Chat Inbox + Comment realtime + Kho khách FB nuôi leads. **BỎ** livestream commerce (giỏ, đơn, KPI, phiếu kẹp kệ — khối 4+6 của spec cũ) |
| 2 | Nền tảng | **Facebook Graph API chính thức** (không Pancake) |
| 3 | Tenancy | **Multi-tenant đúng chuẩn** — mỗi org tự kết nối fanpage, RLS org_boundary |
| 4 | Luồng leads | Kho FB riêng (`fb_contacts`) + **tạo lead có trợ giúp** (nút bấm + banner dò SĐT), KHÔNG auto-tạo |
| 5 | Kiến trúc | **B — Supabase + worker VPS** (webhook edge function + worker gửi tin/poll live/watchdog) |
| 6 | App Review | User xác nhận có giấy ĐKKD, chấp nhận đường Business Verification + App Review (~2–4 tuần, chạy song song với dev) |

## 1. Facts nền từ Graph API (v26.0, kiểm chứng 08/2026) — ràng buộc thiết kế

Những điều dưới đây là **luật của Meta**, thiết kế phải phục tùng:

1. **App Review là bắt buộc, kể cả cho page của chính mình.** App loại Business không có dev/live
   mode; Standard Access chỉ nhận webhook từ người có role trong app. Khách thật nhắn tin **không
   sinh webhook** cho tới khi có Advanced Access. → Lộ trình 2 pha: dev/test bằng user có role
   (đầy đủ chức năng), go-live sau duyệt.
2. **Webhook-first là bắt buộc.** Conversations API chỉ đọc được **20 tin gần nhất**/thread và
   rate limit **2 call/giây/page**. → DB của mình là nguồn sự thật; mọi tin đi qua webhook
   `messages` + `message_echoes`; Conversations API chỉ để đối soát lúc kết nối page.
3. **Webhook `feed` phủ comment** trên bài thường, bài quảng cáo (ad/dark post) và trong livestream.
   Meta có thể **bắn trùng và sai thứ tự** → dedup theo `comment_id`+`verb` là bắt buộc.
4. **Cửa sổ nhắn tin 24h**; ngoài 24h chỉ còn tag `HUMAN_AGENT` (7 ngày, người thật, cần App
   Review riêng feature này). 3 tag cũ (`CONFIRMED_EVENT_UPDATE`…) đã chết từ 27/04/2026 (error 100).
5. **Private reply comment**: qua Send API `recipient: {comment_id}`, đúng **1 tin/comment**,
   trong **7 ngày** kể từ lúc comment. Endpoint cũ `/private_replies` đã bị gỡ.
6. **PSID page-scoped** (1 người trên 2 page = 2 PSID). `ids_for_pages` còn chạy nhưng Meta đã rút
   khỏi docs Messenger → không xây logic sống còn trên nó; **SĐT là khoá hợp nhất tin cậy** (trùng
   triết lý spec cũ).
7. **Token**: dùng **System User token (never-expire)** qua Business Manager. Không còn hệ
   auto-refresh JWT như Pancake.
8. **Webhook vận hành**: trả `200` trong **≤5s** (xử lý async); Meta ngắt subscription nếu endpoint
   chết liên tục **1 giờ** (Messenger) → cần watchdog tự re-subscribe; verify `X-Hub-Signature-256`
   (HMAC-SHA256 raw body với App Secret); HTTPS cert công khai hợp lệ.
9. **Rate limits**: Send API text 300 call/s/page; private reply 750/giờ/page; profile PSID cần
   feature "Business Asset User Profile Access" (App Review) — thiếu thì trả object rỗng, UI phải
   chịu được tên/avatar rỗng.
10. **Deadline gần**: webhook sticker đổi attachment type trước 30/08/2026 — handler nhận cả
    `image` lẫn `sticker`. Graph API version pin trong config, nâng theo chu kỳ ~2 năm.

## 2. Kiến trúc tổng thể

```
Meta ──webhook: messages, message_echoes, message_reads, messaging_postbacks, feed, live_videos──►
  Edge Function `facebook-webhook`
    (verify_jwt=false · kiểm X-Hub-Signature-256 TRƯỚC mọi DB call · trả 200 ≤5s ·
     ghi fb_webhook_events thô rồi xử lý trong cùng invocation, không chờ xong mới trả)
        │ upsert fb_conversations / fb_messages / fb_comments / fb_posts / fb_contacts
        ▼
  Supabase Postgres (RLS org_boundary fail-closed, autofill org theo page)
        │ Supabase Realtime (publication + channel filter organization_id)
        ▼
  Frontend React (trang Chat FB · trang Trực comment · Settings kết nối)
        │ gửi tin = RPC enqueue (permission check) → fb_send_queue
        ▼
  Worker VPS `worker-facebook` (Node, mẫu worker/ Zalo):
    • drain fb_send_queue → Graph API Send/comment reply (lease + retry + idempotency)
    • poller comment tần suất cao khi page có live đang phát (biết qua fb_posts.live_status)
    • watchdog re-subscribe webhook + health-check token + đối soát định kỳ
```

**Phân vai rõ**: Edge function = tai (nhận); worker = tay (gửi + poll); Postgres = nguồn sự thật;
browser chỉ nói chuyện với Supabase — **không bao giờ** thấy page token, không gọi Graph API trực
tiếp (sửa lỗ hổng token-trong-localStorage của bản Pancake).

## 3. Data model — bảng `fb_*`

Mọi bảng: `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT`, index
org, policy `<t>_org_boundary` RESTRICTIVE **không nhánh NULL**, trigger autofill fail-closed suy từ
`fb_pages` (mẫu migration Zalo `20260813100000_zalo_khu_rieng_theo_cong_ty.sql`). Thời gian lưu
UTC (`timestamptz`), UI hiển thị `Asia/Ho_Chi_Minh`.

### 3.1 `fb_pages` — fanpage đã kết nối theo org
```
id uuid PK · organization_id · page_id text UNIQUE · page_name · avatar_url
token_enc text            -- page token mã hoá (AES-256-GCM, key từ secret server)
token_status text         -- ok | invalid | unchecked
subscribed_fields text[]  -- các field webhook đã subscribe
subscribe_status text · last_webhook_at timestamptz   -- đối soát sức khoẻ
is_active boolean · created_at · updated_at
```
- Cột `token_enc` KHÔNG lộ ra client: RLS SELECT qua **view `fb_pages_public`** (không có cột token);
  bảng gốc chỉ service_role + RPC quản trị đọc/ghi.
- Giải mã token chỉ ở edge function/worker (key trong Supabase secrets / env worker).

### 3.2 `fb_conversations` — thread inbox
```
id uuid PK · organization_id · page_id · psid text
UNIQUE (page_id, psid)
contact_id uuid NULL REFERENCES fb_contacts
snippet text · unread_count int · message_count int
last_inbound_at timestamptz    -- tin khách gần nhất → tính cửa sổ
window_expires_at timestamptz  -- last_inbound_at + 24h (denormalized, worker/trigger cập nhật)
human_agent_expires_at timestamptz -- last_inbound_at + 7d
last_message_at timestamptz · is_archived boolean
```

### 3.3 `fb_messages`
```
id uuid PK · organization_id · conversation_id FK · page_id
mid text UNIQUE               -- khoá dedup DUY NHẤT (Meta bắn trùng webhook)
direction text                -- in | out
source text                   -- webhook | echo_app | echo_business_suite | api_send
  -- echo có app_id: 26390203743090 = gửi tay từ Page Inbox/Business Suite; app_id của mình = tin CRM gửi
sender_psid text · text_content text
attachments jsonb             -- [{type: image|video|audio|file|sticker|reel|..., url, ...}]
reply_to_mid text · status text  -- sent | delivered | read (watermark) | failed
created_time timestamptz · raw jsonb NULL   -- payload gốc (retention xem §3.8)
```

### 3.4 `fb_posts` — bài viết / live đã biết tới
```
id uuid PK · organization_id · page_id · post_id text UNIQUE
kind text          -- post | live_video
live_video_id text · live_status text  -- LIVE | LIVE_STOPPED | VOD | NULL (webhook live_videos)
message_excerpt text · permalink_url text · created_time · updated_at
```
`live_status='LIVE'` là công tắc bật poller tần suất cao của worker.

### 3.5 `fb_comments`
```
id uuid PK · organization_id · page_id · post_id · comment_id text UNIQUE  -- MỘT khoá duy nhất
parent_comment_id text NULL · from_psid text · from_name text
message text · attachment jsonb · is_hidden boolean · is_removed boolean
verb_log jsonb                 -- lịch sử add/edit/hide/unhide đã xử lý (dedup)
private_reply_sent_at timestamptz NULL   -- đã dùng 1 lần private reply chưa
private_reply_deadline timestamptz       -- created_time + 7d
live_broadcast_timestamp int NULL · contact_id uuid NULL
created_time timestamptz · updated_at
```
Sửa tận gốc "bẫy 3 kiểu ID" của spec cũ: `comment_id` của Graph API là khoá duy nhất, mọi nguồn
(webhook, poller, đối soát) đều upsert vào cùng khoá.

### 3.6 `fb_contacts` — kho khách FB (khối 5 spec cũ, giữ nguyên triết lý)
```
id uuid PK · organization_id
psids jsonb DEFAULT '{}'      -- canonical {psid: page_id}; ghi qua MỘT chokepoint (RPC/func duy nhất)
name text · avatar_url text
phone text NULL               -- CHỈ ^0\d{9}$ hoặc NULL; UNIQUE theo org: UNIQUE (organization_id, phone)
alt_phones jsonb DEFAULT '[]' · address text NULL
note text · tags jsonb DEFAULT '[]'
lead_id uuid NULL REFERENCES leads · customer_id uuid NULL  -- link mềm
source text · created_at · updated_at
GIN index trên psids, alt_phones
```
**Bất biến kế thừa từ spec cũ** (đã trả giá bằng bug thật, vẫn đúng):
- `phone` chuẩn hoá `^0\d{9}$` hoặc NULL; `normPhone` trả NULL cho rác, không passthrough.
- Nhận diện khách = phone chính OR alt_phones — MỘT hằng số SQL dùng cho mọi đường ghi.
- **Không ghi đè** (fill-if-empty): name chỉ khi placeholder; phone/address chỉ khi rỗng; SĐT mới
  khác chính → đẩy `alt_phones`. Guard TOCTOU đặt TRONG câu UPDATE (`WHERE phone IS NULL…`).
- PSID page-scoped → không auto-merge contact chỉ vì trùng tên; hợp nhất bằng SĐT hoặc tay.

### 3.7 `fb_send_queue` — hàng đợi gửi (mẫu `zalo_send_queue` + `worker/lib/queue.js`)
```
id uuid PK · organization_id · page_id
kind text            -- inbox_text | inbox_attachment | comment_reply | private_reply |
                     -- comment_hide | comment_unhide | typing | mark_seen
payload jsonb        -- {psid?, comment_id?, text?, attachment?, tag?: 'HUMAN_AGENT', reply_to_mid?}
idempotency_key text UNIQUE · status text  -- pending | leased | sent | failed | dead
lease_until timestamptz · attempts int · last_error text
requested_by uuid    -- user tạo lệnh (audit)
result jsonb         -- {mid} khi thành công
created_at · updated_at
```
Enqueue CHỈ qua RPC `fb_enqueue_send(...)`: check quyền `chat_facebook.send`, check cửa sổ 24h/7d
ngay tại DB (từ chối sớm với message rõ), sinh idempotency_key.

### 3.8 `fb_webhook_events` — log thô
```
id bigserial PK · received_at · topic text · object_id text · signature_ok boolean
payload jsonb · processed boolean · error text
```
Retention: cron xoá >30 ngày (spec cũ ghi nhận lỗi "bảng tăng vô hạn" — sửa ngay từ đầu).

## 4. Luồng xử lý chính

### 4.1 Nhận webhook (edge function)
1. GET verify (`hub.challenge`) cho lúc đăng ký.
2. POST: đọc **raw body** → HMAC-SHA256 với App Secret, so `X-Hub-Signature-256`
   (`timingSafeEqual`) — **fail thì 401, không chạm DB**.
3. Ghi `fb_webhook_events` → xử lý từng entry (batch tới 1000): route theo field
   (`messages`/`message_echoes`/`message_reads`/`feed`/`live_videos`) → upsert bảng tương ứng
   (dedup `mid`/`comment_id`+verb) → cập nhật `fb_conversations` (snippet, unread,
   window_expires_at) → harvest `fb_contacts` (fill-if-empty; dò SĐT trong text bằng regex
   `(?:\+?84|0)(\d{9})(?!\d)` sau khi strip `[.\s()\-_]`).
4. Trả 200 nhanh; lỗi xử lý ghi vào `fb_webhook_events.error` (không làm Meta retry vô ích).
5. Realtime của Supabase tự đẩy thay đổi bảng → UI invalidate (payload postgres_changes bị UI bỏ
   qua, chỉ dùng làm tickle — giữ nguyên triết lý "không PII trong kênh đẩy" + 3 quy tắc chống
   egress: debounce ≥400ms, cột tường minh, LIMIT trần).

### 4.2 Gửi tin
```
UI → RPC fb_enqueue_send (check quyền + cửa sổ) → fb_send_queue
Worker: lease → giải mã token page → POST /{page-id}/messages (messaging_type RESPONSE
  hoặc MESSAGE_TAG + HUMAN_AGENT nếu ngoài 24h & còn trong 7d)
  → thành công: status='sent', lưu mid → webhook message_echoes về sẽ khớp mid (vòng kín)
  → lỗi: phân loại — 4xx vĩnh viễn (dead + báo UI) vs tạm thời (retry backoff, tối đa N lần)
```
Ảnh/file: upload trước qua `POST /me/message_attachments` (attachment_id, hạn 90 ngày), file
gốc đưa lên Supabase Storage rồi worker lấy URL ký gửi Meta.

### 4.3 Comment & private reply
- Reply công khai: queue kind `comment_reply` → `POST /{comment-id}/comments`.
- Nhắn riêng: kind `private_reply` → `POST /{page-id}/messages` với `recipient:{comment_id}`;
  RPC từ chối nếu `private_reply_sent_at` đã có hoặc quá `private_reply_deadline`; thành công thì
  set `private_reply_sent_at` + tạo/link `fb_conversations` (private reply mở thread inbox).
- Ẩn/bỏ ẩn: kind `comment_hide|unhide` → `POST /{comment-id}?is_hidden=` (Graph API bỏ ẩn ĐƯỢC —
  tốt hơn Pancake); webhook verb hide/unhide đồng bộ ngược trạng thái.

### 4.4 Live comment (poller worker)
- Webhook `live_videos` đổi status → cập nhật `fb_posts.live_status`.
- `live_status='LIVE'` → worker poll `GET /{live-video-id}/comments?live_filter=no_filter&order=reverse_chronological&since=<cursor>`
  mỗi 3–5s, upsert `fb_comments` (cùng khoá `comment_id` → webhook đến sau tự dedup).
- Live kết thúc → tắt poll. Webhook `feed` vẫn là lưới an toàn nếu poller chết.
- (Tuỳ chọn về sau: SSE `streaming-graph.facebook.com/.../live_comments` làm kênh tăng tốc — không
  bao giờ là kênh duy nhất.)

### 4.5 Kết nối page mới (settings, per-org)
1. Admin org dán System User token (hướng dẫn tạo trong Business Manager kèm theo UI) → RPC quản
   trị kiểm token (`GET /me?fields=id,name`) → mã hoá lưu `fb_pages`.
2. Worker/edge gọi `POST /{page-id}/subscribed_apps?subscribed_fields=…` → lưu subscribe_status.
3. Đối soát khởi tạo: kéo `GET /{page-id}/conversations` (20 tin/thread gần nhất) để có danh sách
   thread ban đầu; lịch sử đầy đủ tích luỹ dần qua webhook.

### 4.6 Watchdog (worker, cron nội bộ)
- Mỗi 10 phút: so `fb_pages.last_webhook_at` với hoạt động page; nghi ngờ đứt → gọi
  `GET /{page-id}/subscribed_apps` kiểm, mất thì re-subscribe + cảnh báo (bảng thông báo hiện có).
- Health-check token hàng ngày; `token_status='invalid'` → badge đỏ ở settings.

## 5. Bảo mật & phân quyền

- **RLS**: policy org_boundary RESTRICTIVE fail-closed cho cả 8 bảng; helper
  `fb_authorized_org_ids(action)` theo mẫu `zalo_authorized_org_ids`.
- **Quyền**: module mới `chat_facebook` (nhóm `chat`) — actions tối thiểu: `view`, `send`,
  `manage_comments`, `manage_pages`; khai ở `src/lib/permissions.ts` + `permissionPages.ts`.
- **Token**: chỉ tồn tại dạng mã hoá trong DB + giải mã ở server; view public không có cột token;
  không log token; không đưa vào commit/manifest.
- **Webhook**: signature verify trước mọi DB call; `verify_jwt=false` khai tường minh trong
  `supabase/config.toml`; cập nhật `contracts/surfaces/edge-function-surface.json`.
- **Worker**: dùng service key Supabase (như worker Zalo), env riêng trên VPS, không nằm trong repo
  public path nào; secrets nạp qua env file chmod 600.
- PII: mask SĐT ở copilot qua `maskPii` sẵn có; log worker không in nội dung tin nhắn.

## 6. Frontend

### 6.1 Trang Chat Facebook (`/chat-facebook`) — mẫu ChatZaloPage 3 cột
- **Trái**: chọn page (nếu org nhiều page) + search + chips (Tất cả / Chưa đọc / Có SĐT) + list
  hội thoại (snippet, unread badge, đồng hồ cửa sổ 24h).
- **Giữa**: thread (bubble in/out, phân biệt tin gửi tay từ Business Suite, ảnh/sticker, reply
  theo mid, trạng thái đã đọc theo watermark) + composer (đếm ngược 24h → chuyển chế độ
  HUMAN_AGENT ≤7d → khoá khi hết; typing/mark_seen tự động).
- **Phải**: panel khách — `fb_contact` (tên, avatar, SĐT + alt, ghi chú), banner "Phát hiện SĐT
  trong hội thoại → Lưu vào contact / Tạo lead", nút **Tạo lead** (prefill tên+SĐT, source
  facebook, link ngược `fb_contacts.lead_id`), lịch sử lead/hợp đồng nếu đã link.

### 6.2 Trang Trực comment (`/facebook-comments`)
- Chọn page + bài (list `fb_posts`, badge ĐANG LIVE); list comment realtime (mọi nguồn: thường,
  quảng cáo, live), dedup sẵn từ DB.
- Mỗi dòng: tên, nội dung, thời gian (GMT+7), badge ẩn/hiện; actions: **Trả lời công khai**,
  **Nhắn riêng** (vô hiệu nếu đã dùng/quá 7d, hiện đếm ngược), **Ẩn/Bỏ ẩn**, gắn SĐT vào contact.
- Cap render + LIMIT trần theo quy tắc egress (mẫu Zalo).

### 6.3 Settings kết nối (trong khu settings, quyền `chat_facebook.manage_pages`)
Kết nối page (dán token → verify → subscribe), trạng thái webhook/token, nút re-subscribe,
hướng dẫn từng bước tạo System User token.

### 6.4 Đăng ký chuẩn repo
Capability registry (`src/app/capabilities/registry.ts`) + route guard (`ProtectedRoute` +
`RequirePermission`) + lazyPages + realtime channel riêng filter org (mẫu `useZaloChat`) + thêm
bảng vào publication realtime bằng migration. Tài liệu `docs/he-thong/25-facebook-inbox.md`.

## 7. Chuẩn bị AI Copilot (pha 5)

- `src/copilot/tools/facebookTools.ts` export mảng `DomainTool`, spread vào registry:
  - Đọc: `fb_tim_hoi_thoai`, `fb_tom_tat_hoi_thoai` (n tin gần nhất), `fb_tra_khach` (theo
    SĐT/tên) — `requiredPermission {module:'chat_facebook', action:'view'}`.
  - Ghi (`chatOnly`): `fb_soan_tra_loi` (draft vào composer — không tự gửi), `fb_gui_tin`
    (qua đúng RPC `fb_enqueue_send`, quyền `send`) — mặc định giai đoạn đầu chỉ bật draft.
- Vì mọi thao tác ghi đi qua RPC có guard, copilot không mở thêm mặt tấn công mới.
- Tương lai xa (ngoài phạm vi spec này): auto-suggest trả lời theo ngữ cảnh phòng trống — cần
  quyết định riêng về chính sách tự động hoá (chú ý luật HUMAN_AGENT cấm bot).

## 8. Lộ trình pha (mỗi pha một implementation plan riêng)

| Pha | Nội dung | Ghi chú |
|---|---|---|
| **0** | Meta App (Business) + Business Verification + App Review: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_show_list`, feature Business Asset User Profile Access, feature Human Agent | User thao tác theo hướng dẫn soạn sẵn (kèm checklist screencast). Chạy **song song** pha 1–4. Tạo app MỚI, không tái dùng app thử nghiệm cũ |
| **1** | Nền tảng: migration 8 bảng `fb_*` + RLS + realtime publication; edge function `facebook-webhook`; settings kết nối page; đăng ký quyền/capability/route | Test đủ bằng user có role trong app |
| **2** | Inbox: worker `worker-facebook` (send queue) + trang Chat 3 cột + cửa sổ 24h/HUMAN_AGENT | |
| **3** | Comment: xử lý `feed` webhook + trang Trực comment + private reply + ẩn/bỏ ẩn + poller live | |
| **4** | Kho khách: harvest fill-if-empty + dò SĐT + nút tạo lead + link contact↔lead | |
| **5** | Copilot tools (đọc trước, draft sau) | Sau khi 2–4 ổn định |

Go-live thật (khách ngoài) chỉ phụ thuộc pha 0 được duyệt — mọi pha khác không bị chặn.

## 9. Kiểm thử

- **Unit**: normPhone, regex dò SĐT, dedup mid/comment_id+verb, tính cửa sổ 24h/7d, mã hoá token.
- **Webhook simulator**: bộ payload mẫu (messages, echo Business Suite `app_id 26390203743090`,
  read watermark, feed comment add/edit/hide, live_videos status, sticker kiểu mới) + script POST
  có ký HMAC vào edge function — chạy được trong CI không cần Meta.
- **RLS**: test biên tenant theo mẫu `realtimeTenantBoundary.test.ts` — user org A không thấy
  hội thoại org B.
- **E2E** (`.e2e-fleet`, headless, org DEMO): seed dữ liệu fb_* giả → mở 2 trang, kiểm realtime,
  composer khoá đúng cửa sổ, nút private reply vô hiệu sau dùng.
- **Khoảng trống xác minh ghi nhận trước**: hành vi webhook thật của Meta (độ trễ, trùng lặp thực
  tế, profile rỗng) chỉ kiểm được ở pha chạy thật với page test — plan pha 1 có mục "ngày đối
  soát webhook thật".

## 10. Rủi ro & đối sách

| Rủi ro | Đối sách |
|---|---|
| App Review bị từ chối (thường do screencast) | Checklist quay video theo yêu cầu từng quyền; nộp lại nhanh; trong lúc đó dev không bị chặn |
| Meta đổi docs/version (đã dời sang hub business-messaging) | Pin version v26.0 trong config; watchdog log lỗi API bất thường; lịch nâng version ~2 năm |
| `ids_for_pages` bị thu hồi | Không xây logic sống còn trên nó; hợp nhất bằng SĐT |
| Endpoint webhook chết >1h → Meta unsubscribe | Watchdog re-subscribe + cảnh báo; edge function của Supabase có SLA tốt hơn VPS tự vận hành |
| Token System User bị thu hồi (đổi quyền BM) | Health-check hàng ngày + badge đỏ settings + thông báo |
| Bảng tin nhắn/log phình | Retention 30 ngày cho `fb_webhook_events`; `fb_messages` giữ lâu dài (là dữ liệu nghiệp vụ) nhưng có index và LIMIT trần khi đọc |

---

*Spec sinh 2026-08-13. Bước kế tiếp: viết implementation plan cho pha 0+1 (skill writing-plans).*
