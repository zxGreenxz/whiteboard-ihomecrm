# Đặc tả tính năng Facebook (qua Pancake) của Web 2.0 — để tái hiện thực

> **[SPEC THAM CHIẾU HỆ NGOÀI — N2Store/Pancake, KHÔNG mô tả iHomeCRM]** Dùng làm nguồn "bất biến đã trả giá bằng bug" khi port tính năng. Trạng thái port Facebook: thiết kế đã duyệt, chưa triển khai (`docs/superpowers/specs/2026-08-13-facebook-inbox-design.md`).

> **Mục đích**: tài liệu này mô tả TOÀN BỘ tính năng Facebook của hệ Web 2.0 (N2Store) đủ chi tiết
> để một AI agent hiện thực lại trên nền tảng khác — gồm kiến trúc, cấu trúc dữ liệu (DDL), API,
> shape payload, flow xử lý và các bẫy đã trả giá bằng bug thật.
>
> Mọi mục được rút từ **đọc code thật** (kèm `file:line`). Chỗ nào là suy luận sẽ ghi rõ `[SUY LUẬN]`.
> Tên bảng/route/field giữ nguyên như bản gốc để dễ đối chiếu; khi port sang site khác bạn được tự do
> đổi tên, nhưng phải giữ **ngữ nghĩa và các bất biến** đánh dấu ⚠.

---

## PHẦN 0 — Facebook trên Web 2.0 THỰC CHẤT là gì?

Shop bán hàng qua **Facebook Livestream** và **Facebook Inbox/Comment**. Họ KHÔNG gọi Graph API của
Facebook trực tiếp cho nghiệp vụ chính, mà đi qua **Pancake.vn** — một nền tảng trung gian quản lý
nhiều Fanpage (giống Pancake POS / pages.fm). Pancake cung cấp:

- **User API**: `https://pancake.vn/api/v1/*` — auth bằng **JWT** của tài khoản Pancake (`?access_token=<jwt>`).
- **Public API (pages.fm)**: `https://pages.fm/api/public_api/v1/*` — auth bằng **Page Access Token (PAT)** (`?page_access_token=<pat>`).
- **WebSocket Phoenix**: `wss://pancake.vn/socket/websocket` — đẩy realtime comment/inbox.

Toàn bộ tính năng Facebook chia làm **6 khối**:

| # | Khối | Vai trò |
|---|---|---|
| 1 | **Tầng proxy + token** | Server đứng giữa browser và Pancake; quản lý JWT/PAT, refresh tự động |
| 2 | **Pipeline comment livestream** | WS relay 24/7 nhận comment realtime → DB → SSE ra mọi tab |
| 3 | **Bộ chat khách hàng dùng chung** (`Web2CustomerChat` / `Web2Chat`) | Xem hội thoại Inbox/Comment, gửi tin, gửi ảnh, reply comment |
| 4 | **Trang xem comment livestream** (`live-chat/`) | Màn hình thu ngân: xem comment realtime, tạo giỏ/đơn, in phiếu kẹp kệ |
| 5 | **Kho khách hàng** (`web2_customers`) | Gom identity FB (fb_id/global_id/phone) từ comment, chống trùng |
| 6 | **Các nơi tiêu thụ** | Đơn Web (`native_orders`), giỏ kéo-thả, chiến dịch, KPI theo chiến dịch |

**Sơ đồ luồng realtime chính (khối 2):**

```
Facebook  ──►  Pancake  ──WSS Phoenix──►  Relay service (web2-realtime, 24/7)
                                              │  join per-page  pages:{pageId}
                                              ▼
                          POST /api/web2-live-comments/ingest   (x-relay-secret)
                                              │  upsert web2_live_comments
                                              ▼
                          SSE broadcast  topic "web2:live-comments"  (chỉ tickle, KHÔNG PII)
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                    Tab A (live-chat)   Tab B (native-orders)  Tab C (mobile)
                     delta-fetch GET /api/web2-live-comments?postIds=&sinceUpdated=
```

**3 service backend tách biệt** (rất quan trọng khi triển khai hạ tầng):

| Service | Vai trò | File gốc |
|---|---|---|
| `web2-realtime` | WS client Pancake Phoenix 24/7, forward HTTP | thư mục `live-chat/server/` |
| `web2-api` | Backend chính: proxy, DB, SSE hub | `render.com/` (Express) |
| Browser | Frontend: subscribe SSE, fetch Pancake trực tiếp cho danh sách bài | `live-chat/`, `web2/` |

---

## PHẦN 1 — TẦNG PROXY + QUẢN LÝ TOKEN

### 1.1 Vì sao cần proxy?

Browser của nhân viên KHÔNG có session pancake.vn. Nếu gọi thẳng `pancake.vn` từ browser sẽ:
- CORS chặn.
- Lộ JWT toàn quyền inbox trong URL/log.
- Cần cookie/referer giả trình duyệt mà JS không set được.

Nên mọi lời gọi Pancake đi qua server proxy. Có **3 họ endpoint proxy**, khác nhau ở cách gắn auth:

| Route proxy | Forward tới | Auth gắn thế nào | Bảo toàn HTTP status? |
|---|---|---|---|
| `/api/pancake/*` | `pancake.vn/api/v1/*` | Query `?access_token=<jwt>` do client gắn; chỉ thêm `Content-Type` | ❌ **KHÔNG** (mọi lỗi Pancake → 500) |
| `/api/pancake-direct/*` | `pancake.vn/api/v1/*` | **Cookie** `jwt=<jwt>; locale=vi` + Referer giả theo pageId | ✅ Có |
| `/api/pancake-official/*` | `pages.fm/api/public_api/v1/*` | Query `?page_access_token=<pat>` + Origin `pages.fm` | ✅ Có |

**Chi tiết `/api/pancake/*`** (generic proxy, file gốc `render.com/routes/pancake.js`):
```
router.all('/*')                    // GET/POST/PUT/DELETE/PATCH đều qua
PANCAKE_BASE = 'https://pancake.vn/api/v1'
fullUrl = `${PANCAKE_BASE}/${path}${queryString}`   // query giữ NGUYÊN kể cả access_token
```
- Chỉ serialize body cho POST/PUT (⚠ PATCH/DELETE mất body).
- Timeout 15s. TLS `rejectUnauthorized:false`.
- ⚠ **KHÔNG có middleware auth** — endpoint mở, ai có JWT hợp lệ đều dùng.
- ⚠ **Nuốt status code**: non-2xx từ Pancake bị throw → biến thành HTTP 500 với message chứa body gốc.

**Chi tiết `/api/pancake-direct/*`** (file `render.com/routes/cloudflare-backup.js`):
- Bóc `page_id` + `jwt` khỏi query, KHÔNG forward.
- Referer đổi theo pageId (hardcode map pageId→fanpage URL).
- JWT gắn bằng **Cookie** `jwt=<jwt>; locale=vi` — điểm khác cốt lõi so với `/api/pancake/*`.
- Headers giả trình duyệt đầy đủ (`Origin`, UA Chrome, `sec-ch-ua*`, `sec-fetch-*`).
- Bảo toàn status + CORS `*`.

**Chi tiết `/api/pancake-official/*`** (pages.fm Public API):
- `targetUrl = https://pages.fm/api/public_api/v1/${apiPath}${queryString}`.
- Auth bằng query `?page_access_token=<pat>`, không cookie.

**Endpoint Pancake thực tế dùng** (đầy đủ, để biết cần proxy những gì):
```
GET  /api/pancake/pages?access_token=<jwt>                                     → list fanpage
GET  /api/pancake/pages/{pageId}/posts?access_token&start_time&end_time        → danh sách bài (livestream)
GET  /api/pancake/pages/{pageId}/conversations?access_token&page_id&type=INBOX|COMMENT[&post_id&since&until&tag_id&limit]
POST /api/pancake/pages/{pageId}/conversations/search?q=&access_token=         → search (body RỖNG cố ý, né preflight)
GET  /api/pancake/conversations/customer/{fbId}?pages[{pageId}]=0&access_token= → hội thoại theo khách
POST /api/pancake/pages/{pageId}/generate_page_access_token?access_token=<jwt> → mint PAT → {success, page_access_token}
POST /api/pancake/pages/{pageId}/conversations/{convId}/messages?access_token= → boost comment (reply_comment)
GET  /api/pancake-direct/pages/{pageId}/conversations/{convId}/messages?page_id&jwt&access_token[&customer_id][&current_count]
GET|POST /api/pancake-official/pages/{pageId}/conversations/{convId}/messages?page_access_token=
POST /api/pancake-official/pages/{pageId}/comments/{commentId}/replies?page_access_token=  body {message, type:'public'|'private'}
POST /api/pancake-official/pages/{pageId}/upload_contents?page_access_token=   FormData{file} → {id, attachment_type}
POST /api/pancake-official/pages/{pageId}/conversations/{convId}/read | /unread
```

**Ảnh/avatar** (SSRF cần chú ý khi port):
```
GET /api/fb-avatar?id=<fbId>&page=<pageId>[&token=<jwt>]
    → chain: pancake.vn/api/v1/pages/{pageId}/avatar/{fbId} → graph.facebook.com/{fbId}/picture → SVG placeholder inline
    → cache 24h. ⚠ KHÔNG đính JWT vào ?token (log lộ token toàn quyền inbox).
GET /api/pancake-avatar?hash=<hash>  → content.pancake.vn/2.1-24/avatars/{hash}
GET /api/image-proxy?url=<encoded>[&w=1..4000][&q=1..100]   → resize sharp, cache 24h
    ⚠ Bản gốc KHÔNG có allowlist host → SSRF surface. Khi port PHẢI thêm allowlist:
      ['pancake.vn','content.pancake.vn','graph.facebook.com','*.fbcdn.net', ...]
```

### 1.2 Cấu trúc lưu token — 4 nơi

Token Pancake được lưu ở nhiều nơi vì lịch sử; khi tái hiện thực nên **gom về 1 bảng Postgres**.

**(a) `pancake_accounts`** (Postgres, nguồn chính) — cột:
```
account_id (PK, = JWT uid)   uid   name   token (JWT)   token_exp   fb_id   fb_name
saved_at   last_used_at   is_active   pages (JSONB)
-- migration cho auto-refresh:
login_identity TEXT   login_password_enc TEXT   auto_refresh BOOLEAN DEFAULT false
last_refresh_at TIMESTAMP   last_refresh_status TEXT
-- index:
idx_pancake_acc_active   idx_pancake_acc_last_used
idx_pancake_acc_auto_refresh (partial WHERE auto_refresh = TRUE)
```
`fb_id`/`fb_name` được **decode từ JWT payload** phía server khi sync.

**(b) `pancake_page_access_tokens`** (Postgres) — cache PAT per-page:
```
{ [pageId]: { token, pageId, pageName, timestamp, savedAt, generatedBy } }
```
Kèm distributed lock (1-statement UPSERT, TTL 1–30s) để 2 tab không cùng mint PAT.

**(c) `pancake_account_pages_cache`** (Postgres) — cache `accountId → pages[]`, không TTL; PUT chỉ
overwrite khi `lastStatus === 'ok'` (fail thì giữ pages cũ).

**(d) `realtime_credentials`** (Postgres) — cho relay WS đọc lúc boot:
```sql
CREATE TABLE realtime_credentials (
    id SERIAL PRIMARY KEY,
    client_type VARCHAR(20) UNIQUE CHECK (client_type IN ('pancake','tpos')),
    token TEXT NOT NULL, user_id VARCHAR(50), page_ids TEXT, cookie TEXT,
    room VARCHAR(100), is_active BOOLEAN DEFAULT TRUE, updated_at TIMESTAMP DEFAULT NOW()
);
```
⚠ Bản gốc còn dùng **Firestore `pancake_tokens/accounts`** làm nguồn boot ưu tiên (di sản). Khi port
site mới, **bỏ Firestore, chỉ dùng Postgres** — đơn giản hơn nhiều. Shape Firestore để tham khảo:
`{ data: { [uid]: { token, uid, name, exp, cookie } } }`.

### 1.3 Route quản lý token (API)

```
GET    /api/pancake-accounts[?active=true]      → {success, accounts:[{...row, has_token, token?}]}
GET    /api/pancake-accounts/:accountId
POST   /api/pancake-accounts/sync               body {accounts:{[id]:{token,exp,uid,name,savedAt}}}
PUT    /api/pancake-accounts/:accountId         body {token?,exp?,name?,pages?,is_active?}
DELETE /api/pancake-accounts/:accountId
GET    /api/pancake-page-tokens                 → {success, tokens:{[pageId]:{token,...}}}
PUT    /api/pancake-page-tokens/:pageId
DELETE /api/pancake-page-tokens/:pageId
POST   /api/pancake-page-tokens/:pageId/lock    body {ttlMs?}   → {acquired, lockUntil}
GET    /api/web2/pancake-refresh/status
PUT    /api/web2/pancake-refresh/:accountId/credentials   body {identity,password,auto_refresh}
POST   /api/web2/pancake-refresh/:accountId               → refresh JWT ngay
```
⚠ Bản gốc để nhiều route token **không auth** (page-tokens, account-pages) hoặc soft-auth. Khi port
site mới **NÊN gate hết** — đây là secret nhạy cảm.

### 1.4 Auto-refresh JWT (phần tinh vi nhất)

Pancake **revoke token phía server** (trả `error_code: 105`) dù `exp` claim còn xa (thực tế: refresh
13/07 ok → 15/07 đã 105). Nên không thể tin `exp`, phải health-check.

**Login thuần Node (không browser)** — OAuth2 3 bước với `account.pancake.vn`:
```
1. GET  account.pancake.vn/oauth2/authorize?grant_type=code&client_id=<CLIENT_ID>
        &redirect_uri=...pancake_id_login_success&scope=avatar,email,subscriptions
        &verification_method=email&locale=vi&is_mobile_fb=true&isMFb=true&state=<STATE>
        → parse hidden: _csrf_token, device_info, _query_string
2. POST account.pancake.vn/page/login     body urlencoded {_csrf_token, device_info, _query_string, identity, password}
3. POST <formAction> (approve)            body {_csrf_token, approve:'true'}   → redirect set cookie jwt
```
Chi tiết hạ tầng phải giữ:
- `CLIENT_ID` + `STATE` là hằng số hardcode (không phải secret).
- Cookie jar tự viết; `redirect:'manual'`, max 20 hop, redirect luôn đổi sang GET + drop body.
- ⚠ Header `Accept` phải rộng — endpoint `pancake_id_login_success` trả **406** nếu Accept quá hẹp.
- Trả `{ok:true, token, decoded}` | `{ok:false, reason}` với reason ∈ `missing_credentials|no_csrf|login_failed|needs_otp|approve_failed|no_jwt|bad_token`.

**Mã hoá password lưu DB**: AES-256-GCM, key = `sha256(SECRET_ENV)`, ciphertext = `base64(iv|tag|cipher)`.

**Cron refresh** (mỗi 1 giờ):
```
1. Quét WHERE auto_refresh=true AND login_password_enc IS NOT NULL
2. nearExp = !token_exp || token_exp <= now + 5 ngày
3. Chưa near-exp → health-check GET pancake.vn/api/v1/pages?access_token=
      chỉ coi là CHẾT khi body có error_code 105|190; lỗi mạng/5xx → coi là SỐNG (tránh login thừa)
   Sống → skip.
4. Chết hoặc near-exp → login lại → UPSERT pancake_accounts (account_id = decoded.uid, ưu tiên uid trong token)
5. Throttle 1500ms giữa các account.
```

⚠ **Bẫy quan trọng**: Pancake trả **HTTP 200 kèm `error_code`/`success:false`** khi token chết
(`105` revoke, `190` invalid, `122` hết gói cước). PHẢI tự check body, KHÔNG dựa HTTP status.

### 1.5 Token phía client (browser)

localStorage keys (dùng chung Web 1.0/2.0):
```
pancake_jwt_token          → JWT active
pancake_jwt_token_expiry   → epoch giây
pancake_page_access_tokens → { [pageId]: {token,...} }
pancake_all_accounts       → { [accountId]: {token,exp,uid,name,fbId,fbName,pages} }
web2_pancake_active_account_id
```
Hàm chính:
- `getJwt()` — trả `null` nếu hết hạn (đệm 30s: `Date.now()/1000 >= exp - 30`).
- `syncFromRenderDB({force})` — **once-per-session + single-flight**, timeout 8s. Fetch song song
  `GET /api/pancake-accounts?active=true` + `GET /api/pancake-page-tokens`; ghi vào localStorage;
  promote 1 account chưa hết hạn thành JWT active; page tokens **smart-merge theo `savedAt` mới hơn**.
- `generatePageAccessToken(pageId)` — mint PAT: thử lần lượt các account (admin page đó → JWT active
  → mọi account còn hạn) cho tới khi `POST .../generate_page_access_token` trả `{success, page_access_token}`.
- ⚠ Không có refresh JWT tự động ở client — hết hạn thì `getJwt()` trả null, phải sync lại từ DB.

---

## PHẦN 2 — PIPELINE COMMENT LIVESTREAM

Đây là trái tim của tính năng. Comment Facebook trong lúc livestream phải hiện realtime trên màn hình
thu ngân, gắn SĐT/địa chỉ, tạo đơn.

### 2.1 Kiến trúc: PUSH-only, KHÔNG polling

Bản gốc đã **bỏ hẳn polling nền** (event-driven). Đừng tái hiện thực bằng `setInterval` poll.

```
Relay service (24/7)                         Backend web2-api                    Browser
─────────────────                            ───────────────                    ───────
WS Phoenix wss://pancake.vn/socket/websocket
  join users:{userId}
  join pages:{pageId}  (PER-PAGE, xem ⚠ dưới)
       │ event pages:update_conversation
       │ (conv.type=='COMMENT' && conv.post.type=='livestream')
       ▼
  POST /api/web2-live-comments/ingest ───────► upsert web2_live_comments
       (header x-relay-secret)                 _notify('realtime', postId)
                                                     │
                                               SSE "web2:live-comments" ─────────► LiveCommentsStream
                                               {action, postId, ts}  (KHÔNG PII)   debounce 400ms
                                                                                        │
                                               GET /api/web2-live-comments ◄───────────┘
                                               ?postIds=..&sinceUpdated=..&limit=2000
```

⚠ **Join PER-PAGE `pages:{pageId}`, KHÔNG dùng `multiple_pages:`** — nếu 1 page hết gói cước
(err 122), Pancake reject CẢ BÓ → 0 comment cho mọi page.

**WS client Phoenix chi tiết** (`live-chat/server/pancake-client.js`):
```
url = 'wss://pancake.vn/socket/websocket?vsn=2.0.0'   (Phoenix protocol v2)
handshake headers: Origin: https://pancake.vn, UA, Cookie: jwt=<token>; locale=vi
join payload:     [ref, ref, "pages:{pageId}", "phx_join", {accessToken, userId, platform:'web'}]
heartbeat 30s:    [null, ref, "phoenix", "heartbeat", {}]
reconnect:        maxAttempts=Infinity, backoff min(2000·2^min(n,5), 60000)
self-heal 60s:    client không connected & không có reconnectTimer → connect()

Event handling:
  pages:update_conversation + conv.type==='COMMENT' + conv.post.type==='livestream'
      → POST /api/web2-live-comments/ingest {conversations:[conv]}
  còn lại (inbox)
      → POST /api/realtime/web2/sse/relay-notify {key:'web2:messages', data:{action,pageId,convId,ts}}
  pages:new_message + from.id !== page_id
      → POST /api/native-orders/customer-reply-relay {fbUserId, pageId}
```

**Boot đọc token** (relay `autoConnect()` sau 2s):
1. Đọc Postgres `realtime_credentials WHERE client_type LIKE 'pancake%' AND is_active=TRUE`
   (bản gốc ưu tiên Firestore trước — bỏ khi port).
2. Mỗi account: `discoverPageIds(token)` = `GET pancake.vn/api/v1/pages` (đọc
   `data.categorized.activated`, **lọc bỏ page Instagram prefix `igo_`**) → lọc theo bảng page bật/tắt
   → `client.start(token, userId, pageIds, cookie)`, stagger 2000ms.

**Heartbeat relay → backend** mỗi 30s: `POST /api/web2-fb-webhook/pancake-health {connected, clients, pages}`
→ backend lưu `app.locals.pancakeWsHealth = {connected, clients, pages, at}`. Dùng cho fallback (§2.7).

### 2.2 Endpoint `/ingest` — nhận comment từ relay

```
POST /api/web2-live-comments/ingest
Auth: header x-relay-secret === CLEANUP_SECRET (fail-closed: thiếu secret → 503, sai → 401)
Body (3 dạng): {conversations:[conv]} | {conversation} | conv trần
```
Xử lý:
1. **Lọc boost-suppress** — bỏ comment do page tự reply để tăng count:
   `conv.from.id === conv.page_id` HOẶC `conv.last_sent_by.id === conv.page_id` HOẶC conv trong `_boostMarks` (TTL 20 phút). "Bỏ" = không upsert + không notify.
2. **Map WS conv → comment row** (`_mapWsConvToComment`):
   ```
   id          = `${conv.id}_${message_count}`   ⚠ xem bẫy ID dưới
   postId      = conv.post_id
   pageId      = conv.page_id
   fbId        = conv.customers?.[0]?.fb_id || conv.from?.id
   name        = conv.from?.name || conv.customers?.[0]?.name
   message     = conv.snippet || ''
   createdTime = conv.updated_at || conv.inserted_at
   phone       = conv.recent_phone_numbers?.[0]?.phone_number || null
   hasOrder    = conv.has_livestream_order || false
   _custUuid   = conv.customers?.[0]?.id   (dùng cho enrich, không lưu)
   ```
3. **Upsert** — batch 200 row/INSERT, `ON CONFLICT (id) DO UPDATE`:
   ```sql
   message       = EXCLUDED.message,                                    -- LUÔN ghi đè (để reconcile vá)
   phone         = COALESCE(NULLIF(existing.phone,''), EXCLUDED.phone), -- fill-if-empty
   address       = COALESCE(NULLIF(existing.address,''), EXCLUDED.address),
   customer_name = COALESCE(NULLIF(existing.customer_name,''), EXCLUDED.customer_name),
   avatar        = COALESCE(NULLIF(existing.avatar,''), EXCLUDED.avatar),
   has_order     = existing.has_order OR EXCLUDED.has_order,            -- sticky OR
   campaign_id   = COALESCE(EXCLUDED.campaign_id, existing.campaign_id),
   updated_at    = EXCLUDED.updated_at
   ```
   (kế thừa `campaign_id` từ `web2_live_post_assign` theo `post_id`, fail-open).
4. Sau lưu: `_notify('realtime', postId)` cho mỗi postId; **reconcile full-text** cho comment kết
   thúc `…` (semaphore max 6 in-flight); **enrich profile** (SĐT/địa chỉ/avatar/global_id) fire-and-forget.

Response: `{success, ingested, suppressed}`.

### 2.3 Bảng `web2_live_comments` — DDL

```sql
CREATE TABLE web2_live_comments (
    id            VARCHAR(120) PRIMARY KEY,   -- WS: `${convId}_${message_count}`
    post_id       VARCHAR(120),               -- bài livestream (FB post id)
    page_id       VARCHAR(50),
    page_name     VARCHAR(255),
    campaign_id   VARCHAR(120),               -- ⚠ VARCHAR ở đây, BIGINT ở web2_live_post_assign
    fb_id         VARCHAR(50),                -- PSID (page-scoped!)
    customer_name VARCHAR(255),
    message       TEXT,
    created_time  TIMESTAMPTZ,
    phone         VARCHAR(20),
    address       TEXT,
    has_order     BOOLEAN DEFAULT false,
    avatar        TEXT,
    data          JSONB,                      -- khai báo nhưng KHÔNG bao giờ ghi (cột chết)
    created_at    BIGINT,
    updated_at    BIGINT,
    ticket_print_count      INTEGER NOT NULL DEFAULT 0,   -- in phiếu kẹp kệ
    ticket_last_printed_at  BIGINT
);
CREATE INDEX idx_w2lc_post     ON web2_live_comments(post_id);
CREATE INDEX idx_w2lc_page     ON web2_live_comments(page_id);
CREATE INDEX idx_w2lc_campaign ON web2_live_comments(campaign_id);
CREATE INDEX idx_w2lc_created  ON web2_live_comments(created_time DESC);
CREATE INDEX idx_w2lc_updated  ON web2_live_comments(updated_at);   -- cursor delta-sync
```

Bảng chiến dịch đi kèm:
```sql
CREATE TABLE web2_live_parent_campaigns (         -- "chiến dịch CHA" (gộp nhiều bài live)
    id BIGSERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, note TEXT, created_at BIGINT);
CREATE TABLE web2_live_post_assign (              -- gán bài → chiến dịch
    post_id VARCHAR(120) PRIMARY KEY, campaign_id BIGINT,     -- ⚠ BIGINT
    page_id VARCHAR(50), post_title TEXT, assigned_at BIGINT);
CREATE TABLE web2_live_post_titles (              -- cache title bài
    post_id VARCHAR(120) PRIMARY KEY, page_id VARCHAR(50), title TEXT, updated_at BIGINT);
CREATE TABLE web2_live_saved (                    -- "Lưu Live" (đánh dấu khách)
    customer_id VARCHAR(50) PRIMARY KEY, customer_name VARCHAR(255),
    page_id VARCHAR(50), page_name VARCHAR(255), saved_by VARCHAR(120), notes TEXT, created_at BIGINT);
```

### 2.4 Endpoint đọc comment — `GET /api/web2-live-comments`

Đây là endpoint quan trọng nhất (mọi tab delta-fetch qua đây):
```
GET /api/web2-live-comments?postIds=<csv>&pageIds=<csv>&campaignId=<id>
    &since=<epoch_ms>&sinceUpdated=<epoch_ms>&limit=<≤5000>
```
- `postIds` → `post_id = ANY($n)`.
- `campaignId` → KHÔNG filter thẳng; resolve post_ids của campaign rồi:
  `(campaign_id = $c OR (campaign_id IS NULL AND post_id = ANY($p)))` — SARGable (dùng index).
- `since` → `created_time >= $n`. `sinceUpdated` → `updated_at >= $n`.
- ⚠ **ORDER BY động** — bất biến sống còn:
  ```
  có sinceUpdated  → ORDER BY updated_at ASC     (cursor tiến monotonic, không mất tin)
  không            → ORDER BY created_time DESC
  ```
  Lý do: nếu delta cursor mà ORDER BY `created_time DESC` + LIMIT, Postgres cắt theo created_time →
  dải giữa updated_at thấp hơn **mất VĨNH VIỄN** vì client advance cursor. Và cursor phải là
  `updated_at` (không phải created_time) vì: (a) comment bị UPDATE (poller fill phone) không đổi
  created_time; (b) comment post B về trễ với created_time < max(post A) bị loại vĩnh viễn.

Client (`LiveCommentsStream`): cursor overlap −3000ms; live mới 0 comment → seed `now − 60s`;
debounce 400ms.

### 2.5 Bẫy ID trùng — quan trọng nhất khi port

Cùng 1 comment có thể sinh ra từ 3 nguồn với 3 kiểu ID khác nhau:
```
WS relay:      id = `${conv.id}_${message_count}`
REST fetch:    id = `${postId}_${messageId}`
FB webhook:    id = `fbwh_${commentId}`
```
→ Toàn bộ logic dedup phức tạp (content-dedup theo fb_id + |Δt|≤3000ms, reconcile theo nội dung)
tồn tại VÌ lý do này. **Khi tái hiện thực nên thống nhất 1 khoá ID duy nhất** (khuyến nghị:
`${postId}_${commentId}` — ổn định, không phụ thuộc message_count/seq).

⚠ `message_count` bắt buộc là số để tách lại convId bằng `id.replace(/_[^_]*$/,'')`. KHÔNG dùng `''`
hay `conv.id` trần (2 comment liên tiếp cùng người sẽ gộp/đè).

### 2.6 Reconcile comment bị cắt "…"

WS chỉ giao `conv.snippet` — bị Pancake cắt ~64 ký tự + `…`. Cần fetch full-text:
```
reconcileFullText(pageId, postId, convId, rowId, custUuid, snippet):
1. Guard in-flight theo rowId.
2. Lấy JWT của page.
3. ⚠ resolve customer_id = UUID KHÁCH (conv.customers[0].id) — KHÔNG phải PSID.
   Thiếu UUID → API trả "Thiếu mã khách hàng" + 0 message → reconcile im lặng thất bại.
4. GET pages/{pageId}/conversations/{convId}/messages?customer_id={uuid}
5. PIN theo prefix: chuẩn hoá snippet (bỏ đuôi …), filter rows.startsWith(prefix), chọn bản DÀI NHẤT.
6. UPDATE web2_live_comments SET message=$1 WHERE id=$3 AND COALESCE(message,'') <> $1
7. rowCount>0 → _notify('reconcile', postId)
```
Backfill hàng loạt: quét `WHERE message LIKE '%…' OR '%...'` mỗi 24-48h.

### 2.7 Fallback REST khi relay WS chết

```
Hằng số: HEALTH_STALE_MS=100000, FALLBACK_STALE_MS=25000, FALLBACK_TICK_MS=12000
_fallbackTick() mỗi 12s:
  relayFresh = health.connected && (now - health.at < HEALTH_STALE_MS)
  relayFresh → return (relay khoẻ = 0 network call)
  ngược lại → với post live mà /ingest im > 25s → pullPostFallback():
    REST fetchPostComments → CONTENT-DEDUP (bỏ comment trùng fb_id + |Δt|≤3000ms) → upsert → _notify('fallback')
```
Nguồn thứ 3: FB Graph webhook (`maybePublishComment`) với health-gate + grace 8s, id = `fbwh_${commentId}`.

### 2.8 Bẫy timezone — Pancake `inserted_at` thiếu `Z`

Pancake trả `inserted_at = "2026-06-11T03:52:23"` (UTC nhưng **KHÔNG hậu tố Z**). Nếu server chạy
TZ khác UTC (bản gốc chạy `Asia/Saigon` +7), `new Date(naiveString)` sẽ lệch. **PHẢI append `Z`**:
```js
function parseUtcTs(s) {
    const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);   // ⚠ regex NEO CUỐI, đừng dùng includes('Z')
    return new Date(hasTz ? s : s + 'Z');
}
```
⚠ Bản gốc đã trả giá 2 migration sửa data lệch ±7h vì bug này. Hiển thị UI luôn dùng
`timeZone: 'Asia/Ho_Chi_Minh'` (GMT+7), lưu DB luôn epoch/UTC.

### 2.9 Lấy danh sách bài livestream

```
GET /api/pancake/pages/{pageId}/posts?access_token=<jwt>&start_time=<s>&end_time=<s>
Lọc bài live:  p.type === 'livestream' || p.is_live_video || p.live_video_id
⚠ Đang live hay không: field THẬT là `live_video_status` ('live' | 'vod')
   → living = (String(p.live_video_status).toLowerCase() === 'live')
   ⚠ live_status / is_living KHÔNG TỒN TẠI trong response posts API (bug bỏ sót bài live).
     Chỉ giữ chúng làm defensive fallback.
Cap 50 bài/request (page_size/page_number bị Pancake bỏ qua) → paginate bằng cursor end_time = oldest - 1.
reactions là OBJECT {like_count, love_count, haha_count,...} → reactionCount = tổng mọi loại.
```

### 2.10 Danh sách endpoint đầy đủ của `/api/web2-live-comments`

| Method | Path | Auth | Ghi chú |
|---|---|---|---|
| POST | `/ingest` | relay-secret | nhận comment từ WS |
| POST | `/boost-mark` | soft | đánh dấu comment boost để suppress |
| POST | `/bulk` | soft | ⚠ cố ý KHÔNG notify (tránh vòng lặp) |
| POST | `/mark-ticket-printed` | soft | đếm in phiếu |
| GET | `/` | soft | **đọc comment (§2.4)** |
| GET | `/stats` | soft | đếm |
| GET/POST | `/campaigns` | soft/soft | list/tạo chiến dịch cha |
| DELETE | `/campaigns/:id` | admin | cascade 6 bảng (transaction) |
| GET | `/assignments`, `/posts`, `/page-posts` | soft | ⚠ `/page-posts` trả 0 trên web2-api sau split, đừng dùng cho UI mới |
| POST | `/campaigns/:id/assign` | soft | gán bài → chiến dịch + adopt drafts |
| POST | `/unassign` | soft | |
| POST | `/saved`, GET `/saved/ids`, DELETE `/saved/:id` | soft | "Lưu Live" |
| POST | `/fallback-pull` | admin | kéo REST thủ công |
| POST/GET | `/backfill-global-ids` | admin | job nền link global_id |

SSE notify: `_notify(action, postId) → notifyClients('web2:live-comments', {action, postId, ts}, 'update')`.
Các action: `realtime | reconcile | fallback | profile-enrich | ticket-print | campaign | saved`.
⚠ Payload KHÔNG chứa PII — chỉ tickle, client tự re-fetch.

---

## PHẦN 3 — BỘ CHAT KHÁCH HÀNG DÙNG CHUNG

Hai lớp: **`Web2Chat`** (API thuần, low-level) và **`Web2CustomerChat`** (UI 3 cột, high-level).

### 3.1 `Web2Chat` — API client (7 module)

Thứ tự load bắt buộc (mỗi module `Object.assign` vào cùng namespace `window.__Web2ChatNS`):
```
utils → tokens → settings → api → live → tags → client(facade LAST)
```
Facade cuối expose `window.Web2Chat`. Sai thứ tự → console.error + module không expose.

**Conversations:**
```js
fetchConversationsByPage(pageId, {tagId?, since?, limit?})
  → GET /api/pancake/pages/{pageId}/conversations?access_token&page_id&type=INBOX[&tag_id&since&limit]
  ⚠ type=INBOX hardcode. Muốn COMMENT phải fetch tay:
    GET .../conversations?type=COMMENT&post_id={postId}&since={now-30d}&until={now}
    ⚠ Pancake lọc post_id KHÔNG chặt → tự lọc String(c.post_id)===String(postId)

searchConversations(pageId, query, {signal})
  → POST /api/pancake/pages/{pageId}/conversations/search?q={query}&access_token=
  ⚠ KHÔNG body, KHÔNG Content-Type (simple POST, né CORS preflight)

fetchConversations(pageId, fbId)       // cache 5 phút, key `${pageId}::${fbId}`
  → GET /api/pancake/conversations/customer/{fbId}?pages[{pageId}]=0&access_token=
```

**Messages (dual endpoint — direct trước, official sau):**
```js
fetchMessages(pageId, convId, customerId, {currentCount?})
  1. GET /api/pancake-direct/pages/{pageId}/conversations/{convId}/messages?page_id&jwt&access_token[&customer_id][&current_count]
     chỉ dùng nếu messages.length > 0, rỗng-không-lỗi → fall through
  2. GET /api/pancake-official/pages/{pageId}/conversations/{convId}/messages?page_access_token[&customer_id][&current_count]
  → {ok, messages, conversation, customers, customerId, via:'direct'|'official'}
  Phân trang tin cũ: truyền currentCount = số tin đã có. Pancake trả newest-first → .reverse() để oldest-first.
```

**Shape message** (suy từ field đọc/ghi):
```
{ id, message|text|content, from:{id,name,picture}, from_admin?, is_admin?,
  inserted_at|created_time|timestamp, attachments:[...], original_message?, is_removed? }
isOutgoing = (from.id === pageId) || from_admin || is_admin
```

**Gửi tin / ảnh / reply comment:**
```js
sendMessage(pageId, convId, {text, action, customerId, repliedMessageId, messageId, attachments, pageAccessToken})
  → POST /api/pancake-official/pages/{pageId}/conversations/{convId}/messages?page_access_token=
    body { action: 'reply_inbox'|'reply_comment', message, conversation_id,
           customer_id?, replied_message_id?, message_id?, content_ids? }
  ⚠ reply_comment BẮT BUỘC message_id = `${post_id}_${comment_id}` (= conv.id của COMMENT), thiếu → error_code 100

uploadMedia(pageId, file)
  → POST /api/pancake-official/pages/{pageId}/upload_contents?page_access_token=  FormData{file}
  → {ok, id, attachment_type}   // id = content_id nhét vào content_ids của sendMessage

replyComment(pageId, commentId, {text, mode:'private'|'public'})
  → POST /api/pancake-official/pages/{pageId}/comments/{commentId}/replies?page_access_token=
    body {message, type}

sendLiveComment(pageId, conv, message, {messageId, postId})   // BOOST comment (tăng comment)
  → POST /api/pancake/pages/{pageId}/conversations/{conv.id}/messages?access_token=<JWT>   // JWT, không PAT
    body {action:'reply_comment', message_id, parent_id:conv.id, user_selected_reply_to:null, post_id, message, send_by_platform:'web'}
```
⚠ Mọi hàm gửi: Pancake trả **HTTP 200 + `success:false`** cho lỗi FB (chính sách 24h `e_code:10/e_subcode:2018278`,
post gone, rate-limit) → phải tự check body. Có retry 1 lần khi `e_code===105` (mint lại PAT rồi gửi lại).

### 3.2 `Web2CustomerChat` — UI 3 cột (high-level)

```js
window.Web2CustomerChat = { open, resolvePancakeConv };
open(opts)      → drawer 2 tab (Pancake | Zalo) mặc định, hoặc opts.layout==='modal' → openModal
openModal(opts) → giao diện 3 cột
```

**3 cột** (grid `320px 1fr 340px`):
| Cột | Nội dung |
|---|---|
| TRÁI | search + filter chips (Tất cả/Chưa đọc/Có SĐT/Thẻ) + list hội thoại |
| GIỮA | thread tin nhắn + composer (mount `Web2ChatPanel`, mode `full`/`readonly`/`picker`) |
| PHẢI | ghi chú nội bộ + đơn hàng + ví + nút Tạo đơn (hoặc HTML do caller truyền) |

**Options chính:**
```
phone, fbId|fbUserId, pageId|fbPageId, name, layout
readonly (modal, chỉ xem)
panels.info (HTML string cột phải), info:false (tắt cột phải)
onPick(cust) → PICKER mode: bấm row trả {phone,name,fbId,pageId,conv} rồi đóng
onAddEntity({phone,address}) → thanh "Phát hiện SĐT → Thêm vào đơn"
onReady(handle,back), onSent({conv,text}), onThreadLoaded
```

**Tìm hội thoại theo SĐT** (`resolvePancakeConv(phone)`):
```
1. syncFromRenderDB()
2. pageIds = union của accounts[*].pages + keys của page access tokens
3. Promise.allSettled(pageIds.map(pid => searchConversations(pid, phone)))   // fan-out song song
4. Chọn "best": conv đầu tiên, ưu tiên type==='INBOX'
Fallback theo fbId: fetchConversations(pageId, fbId) → conv INBOX else list[0]
```

**Luồng gửi tin thật** (extension-first):
```
1. Nếu có browser extension (bypass giới hạn 24h) → gửi qua extension (resolve global_id, upload ảnh, reply)
2. Fallback Web2Chat: uploadMedia → sendMessage
   action = conv.type==='COMMENT' ? 'reply_comment' : 'reply_inbox'
   retry 1 lần khi no_page_access_token || e_code===105 → generatePageAccessToken rồi gửi lại
```

**Realtime**: subscribe SSE `web2:messages` 1 lần, filter theo activeConvId, debounce 800ms.

**Trang dùng `Web2CustomerChat`**: `web2/customers/`, `native-orders/`, `web2/balance-history/`
(picker + readonly export), `web2/jt-tracking/` (Zalo-only).

---

## PHẦN 4 — TRANG XEM COMMENT LIVESTREAM (`live-chat/`)

Màn hình thu ngân desktop. 3 cột cố định (KHÔNG map 1-1 với bài live):
```
#liveColumn  → danh sách comment (nhiều bài live gộp chung 1 list)
#khoSpColumn → panel Kho SP (kéo-thả tạo giỏ)
#videoColumn → iframe FB live + dock biến thể
```

### 4.1 Chọn campaign (multi-select)

- Nguồn Page: `GET /api/pancake-page-tokens`.
- Nguồn Bài live: `GET /api/pancake/pages/{pageId}/posts` (fetch TRỰC TIẾP browser, KHÔNG qua `/page-posts`).
- UI: dropdown checkbox mỗi bài + "Hôm nay"/"Bỏ chọn" → set `selectedCampaignIds` (Set) → debounce
  500ms → load comment của tập postIds.
- "Chiến dịch cha" (📁): gom nhiều bài → 1 chiến dịch, đi chung đường với chọn tay.

### 4.2 Nguồn comment (SSE topics)

| Topic | Xử lý |
|---|---|
| `web2:live-comments` | delta-fetch → prepend UI; `{action:'reconcile', purgedIds}` → xoá dòng |
| `web2:customers` | invalidate cache KH + re-render |
| `web2:native-orders` | reload đơn của post |
| `web2:livestream-snapshots` | refetch thumbnail |
| `web2:live-hidden-commenters` | reload danh sách ẩn |
| `web2:cart`, `web2:products`,... | refresh badge giỏ / catalog |
⚠ Cố ý KHÔNG subscribe `web2:messages` (từng làm trắng cột Live).

### 4.3 Render comment

- Debounce 60ms; so cấu trúc DOM (`_rowSig` hash phone/address/status/message/...) → patch dòng đổi,
  skip dòng không đổi, không patch khi đang gõ (`activeElement`).
- Cap render: initial 200, step 200, max 600 rows (infinite scroll + trim window).
- 1 dòng: avatar, badge STT kệ, tên (→ modal KH), badge trạng thái, nút In phiếu, ví, 🛒 muốn mua,
  💸 báo CK, message, 2 input SĐT/Địa chỉ autosave.
- ⚠ Cap **5000 comment** là giới hạn thật (server chỉ có cursor tiến, không older-pagination).

### 4.4 Comment ẩn — 2 khái niệm khác nhau

| Loại | Cơ chế |
|---|---|
| Ẩn 1 comment trên FB (`is_hidden`) | `PancakeAPI.hideComment` — ⚠ Pancake chỉ ẩn được, KHÔNG bỏ ẩn qua API |
| Ẩn TẤT CẢ comment của 1 người | `web2/live-hidden-commenters` (mặc định ẩn 2 page shop) — client-side filter, không refetch |
Không có "ẩn SĐT" theo nghĩa masking; chỉ validate SĐT đúng 10 số + chế độ Dày đặc ẩn ô nhập.

### 4.5 Force extract — gom KH từ comment

```
_harvestCommentCustomers(comments) → LiveCustomerSync.harvest(list)
  → dedupe _seen (fbId|phone) → debounce 1500ms → batch splice(0,500)
  → POST /api/web2/customers/harvest-comments {comments:[{fbId,name,phone?,fbPageId?}], clientTag}
4 điểm gọi: sau initial load · mỗi delta SSE · click chip ⚡Force extract · auto refocus (throttle 60s)
⚠ Auto refocus CHỈ chạy khi đang capture (frameBufferTimer đang bật).
```
Chip ⚡ Force extract cũng chụp thumbnail client-side (seek iframe VOD → chụp frame, vì yt-dlp/Graph bị
FB chặn từ datacenter).

### 4.6 Tương tác từ comment

**Kéo-thả SP → giỏ** (đường tạo đơn chính):
```
dragstart .inv-card → dataTransfer 'application/x-web2-product' (JSON) | 'application/x-web2-parent'
drop CHỈ trên .live-conversation-item
  groupKey = customer.id || commentId   // giỏ gắn theo fbUserId
  → POST /api/v2/cart/{groupKey}/add
    body { product, customer, user, qty:1, clientEventId, fbContext:{
             fbUserId, fbUserName, fbPageId, fbPageName, fbPostId, fbCommentId,
             liveCampaignId, liveCampaignName, parentCampaignId, message } }
  optimistic + undo-toast 5s
```
**Tạo đơn từ comment**: `POST /api/native-orders/from-comment`.
**In phiếu kẹp kệ**: tạo giỏ trống nếu chưa có → `POST /mark-ticket-printed` → in (count per-comment).
**Reply**: private reply (nhắn inbox).

### 4.7 Phát hiện SĐT trong comment (regex)

```js
message.replace(/[.\s()\-_]/g,'').match(/(?:\+?84|0)(\d{9})(?!\d)/)  → '0'+m[1]
isValidPhone = /^0\d{9}$/   // chặn lưu rác
```
⚠ **Attribution**: KHÔNG dùng regex nội dung để tra kho — chỉ dùng `c.phone` (SĐT trong text có thể
của người khác → kéo nhầm tên/status). Ưu tiên phone: `partner.Phone → kho.phone → pancakePhone → comment.phone`.

⚠ `fb_id` comment là **PSID theo page** → KH cũ ở page khác không khớp; không auto-merge, chỉ gợi ý theo tên.

---

## PHẦN 5 — KHO KHÁCH HÀNG (`web2_customers`)

Gom identity Facebook (fb_id/global_id/phone) từ comment + đơn, chống trùng. Đây là "nguồn sự thật"
về khách; mọi trang khác chỉ là cửa sổ nhìn vào.

### 5.1 DDL

```sql
CREATE TABLE web2_customers (
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(40) UNIQUE,
    name          VARCHAR(255) NOT NULL DEFAULT 'Khách hàng mới',
    phone         VARCHAR(20) UNIQUE,            -- ⚠ chuẩn hoá 10 số, khoá dedup CHÍNH
    email         VARCHAR(255), address TEXT, ward VARCHAR(120), district VARCHAR(120), city VARCHAR(120),
    carrier       VARCHAR(60),
    status        VARCHAR(40) DEFAULT 'Normal',  -- Normal|Bom|Warning|Danger|VIP (MÃ, không phải nhãn)
    status_manual BOOLEAN NOT NULL DEFAULT false, -- pin tay, auto không đè
    tier          VARCHAR(40),
    tags          JSONB DEFAULT '[]',
    aliases       JSONB DEFAULT '[]',
    alt_phones    JSONB DEFAULT '[]',            -- SĐT phụ (chính UNIQUE, phụ không đè)
    alt_addresses JSONB DEFAULT '[]',
    note          TEXT,
    -- FB identity graph:
    fb_id         VARCHAR(50),                   -- PSID mặc định (legacy/1-page, PAGE-SCOPED)
    fb_psids      JSONB DEFAULT '{}',            -- ⚠ canonical {psid: pageId} — multi-page
    global_id     VARCHAR(50),                   -- FB Global Account Id — khoá hợp nhất "1 khách mọi page"
    fb_page_id    VARCHAR(50), fb_name VARCHAR(255),
    -- Pancake:
    pancake_customer_id VARCHAR(60), pancake_conversation_id VARCHAR(80), pancake_page_id VARCHAR(60),
    -- Thống kê derived:
    total_orders INTEGER DEFAULT 0, total_spent NUMERIC DEFAULT 0, bom_count INTEGER DEFAULT 0, last_order_at BIGINT,
    source VARCHAR(20) DEFAULT 'manual', created_by VARCHAR(100), history JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true, created_at BIGINT, updated_at BIGINT, synced_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_web2_customers_phone     ON web2_customers(phone);
CREATE INDEX idx_web2_customers_fb_id     ON web2_customers(fb_id) WHERE fb_id IS NOT NULL;
CREATE INDEX idx_web2_customers_global_id ON web2_customers(global_id) WHERE global_id IS NOT NULL;
CREATE INDEX idx_web2_customers_tags      ON web2_customers USING gin(tags);
CREATE INDEX idx_web2_customers_alt_phones ON web2_customers USING gin(alt_phones);
CREATE INDEX idx_web2_customers_fb_psids  ON web2_customers USING gin(fb_psids);
CREATE UNIQUE INDEX idx_web2_customers_fb_id_unique ON web2_customers(fb_id) WHERE fb_id IS NOT NULL;
```

Thang bậc identity:
```
id        = khoá nội bộ
phone     = UNIQUE 10 số  — khoá dedup CHÍNH
fb_id     = PSID page-scoped (1 người trên 2 page = 2 PSID KHÁC NHAU!)
fb_psids  = {psid: pageId} — multi-page (canonical)
global_id = FB Global Account Id — BẮT BUỘC để gửi tin, khoá hợp nhất mọi page
```

### 5.2 Luật "KHÔNG GHI ĐÈ" — cốt lõi của kho

`POST /api/web2/customers/harvest-comments` — nhận `{comments:[{fbId,name,phone,globalId,fbPageId}], clientTag}`.
Mỗi comment qua `_harvestOneComment`, 3 nhánh:
```
1. Đã có KH theo fb_id?
   - phone chính RỖNG → fill (UPDATE ... WHERE phone IS NULL OR phone='')   ⚠ guard TOCTOU trong SQL
   - phone KHÁC chính → đẩy alt_phones
   - name rỗng/placeholder → fill (WHERE name IN ('','Khách hàng mới','Khách FB'))
   → trả 'filled'|'alt'|'skip'
2. Chưa có theo fb_id, CÓ phone → getOrCreateWeb2Customer(phone) + linkWeb2CustomerFbId → 'created'|'linked'
3. CHỈ có fb_id → INSERT KH FB-only, ON CONFLICT (fb_id) DO NOTHING → 'created'|'skip'
```
Response: `{success, created, linked, altAdded, filled, skipped, processed}`.

**Bất biến phải giữ:**
1. `phone` CHỈ `^0\d{9}$` hoặc NULL. `normPhone` trả `null` cho rác (không passthrough).
2. Nhận diện khách = phone chính OR alt_phones (1 hằng số SQL dùng cho MỌI đường ghi):
   ```sql
   (phone = $1 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(alt_phones,'[]')) ap WHERE ap = $1))
   ```
3. Không ghi đè: name chỉ khi placeholder; address/email/fb_id/global_id chỉ khi rỗng; SĐT mới ≠ chính → alt_phones.
4. Guard TOCTOU đặt TRONG câu UPDATE (`AND name IN (...)`), không chỉ ở JS (NV có thể vừa sửa tab khác).
5. `fb_psids` canonical `{psid: pageId}`; chỉ ghi qua 1 chokepoint (`attachWeb2FbIdentity`).
6. `global_id` là khoá hợp nhất; `fb_id` là PSID page-scoped, KHÔNG unique về người.
7. `status` là MÃ (`Normal|Bom|...`), phải `normStatus` ở PATCH (bug thật: picker gửi `'#5cb85c_Bình thường'` → KH tàng hình).
8. Mọi mutation → SSE `web2:customers` sau commit; harvest kèm `srcClient`+`fbIds` để tab gửi bỏ qua echo của chính mình.

### 5.3 Endpoint kho KH (tóm tắt)

```
GET  /list?search&status&tier&source&tag&activeOnly&page&limit&lapsedDays&minSpent&sort
GET  /status-counts                         (cache 60s)
POST /batch-by-fbid   {fbIds}  → {[fbId]: lite}   (khớp fb_id OR fb_psids ?| $1)
POST /batch-by-phone  {phones} → {[phone]: {Id,Name,Phone,Status,Address}}  (PascalCase compat, KHÔNG có fb_id)
GET  /search?search&limit
GET  /lookup-deep?q&live=1   (fallback 3 tầng: kho → web2_live_comments → live fetch)
GET  /:phone                 (lite, có fbId; chỉ khớp phone chính)
GET  /:phone/orders          (native_orders + fast_sale_orders)
GET  /:phone/fb-conversation (resolve pageId+psid để mở chat)
POST /create | /upsert | /enrich-fb | /merge | /add-alt-phone
POST /harvest-comments       (§5.2)
PATCH /:id                   (cửa ghi chính UI; đổi phone chính → đẩy SĐT cũ vào alt_phones + cascade giỏ)
DELETE /:id?force=true       (>0 đơn && !force → soft-archive is_active=false)
GET/POST /:id/notes
```

### 5.4 Thứ tự "KHO KH TRƯỚC, PANCAKE SAU"

Khi tra cứu 1 KH: **tìm trong kho `web2_customers` trước** (nhanh, local), CHỈ khi kho không có mới
fetch Pancake. Thể hiện ở modal thêm đơn Inbox, hydrate avatar, trang Kho KH (fallback 3 tầng),
backend `/lookup-deep`.

---

## PHẦN 6 — CÁC NƠI TIÊU THỤ

### 6.1 3 khái niệm "campaign" — KHÔNG được lẫn

| Khái niệm | Bảng | Dùng ở |
|---|---|---|
| **Chiến dịch CHA** (Web 2.0, id BIGSERIAL) | `web2_live_parent_campaigns` | picker, native_orders.parent_campaign_id, KPI |
| **Campaign per-post** (Pancake live video) | `native_orders.live_campaign_id` (= Facebook_LiveId) | legacy filter |
| Campaign Web 1.0 | `campaigns` (DB khác) | KHÔNG liên quan Web 2.0 |

### 6.2 Đơn Web (`native_orders`) — cột liên quan FB

```sql
fb_user_id VARCHAR(100)    fb_user_name VARCHAR(255)    fb_page_id VARCHAR(100)
fb_post_id VARCHAR(100)    fb_comment_id VARCHAR(100)   fb_page_name VARCHAR(255)
live_campaign_id VARCHAR(100)     live_campaign_name VARCHAR(255)
parent_campaign_id BIGINT         -- chiến dịch CHA span nhiều page
channel VARCHAR(20) DEFAULT 'web2_livestream'   -- 'web2_livestream' | 'web2_inbox'
comment_ids JSONB DEFAULT '[]'    comment_count INTEGER DEFAULT 1
kpi_base JSONB    kpi_base_at BIGINT    kpi_base_by VARCHAR(120)   -- snapshot "chốt đơn" {productCode: qty}
campaign_stt INTEGER    display_stt INTEGER    split_index INTEGER
products JSONB DEFAULT '[]'        -- giỏ hàng (1 nguồn duy nhất)
customer_id INTEGER               -- soft FK → web2_customers
CREATE INDEX idx_native_orders_fb_user_id ON native_orders(fb_user_id);
CREATE UNIQUE INDEX uq_native_orders_comment ON native_orders(fb_comment_id) WHERE fb_comment_id IS NOT NULL;
```

**`POST /from-comment`** (tạo/gộp đơn từ comment):
```
body {fbUserId*, fbUserName, fbPageId, fbPostId, fbCommentId, liveCampaignId, parentCampaignId, message, phone, address, ...}
1. Idempotency: fb_comment_id đã có → trả đơn cũ; không commentId → cửa sổ 60s theo (fb_user_id, live_campaign_id)
2. Resolve parentCampaignId từ web2_live_post_assign, fallback body
3. Resolve KH: có phone → getOrCreate; không → findByFbId (khớp fb_psids)
4. attachWeb2FbIdentity (ghi fb_psids {fbId:pageId})
5. MERGE draft: WHERE status='draft' AND (customer_id=$1 OR fb_user_id=$2) AND (parent_campaign_id=$3 OR live_campaign_id=$4)
   → UPDATE ATOMIC trong SQL: append note, comment_ids DISTINCT, comment_count+1
```

### 6.3 Giỏ kéo-thả (`POST /api/v2/cart/*`)

⚠ `:commentId` trong URL THỰC CHẤT là **customerId (fbUserId)** — giỏ gắn theo người, 1 khách nhiều comment = 1 giỏ.
- Giỏ = `native_orders.products` (status='draft'), **1 nguồn**. Read-modify-write phải `SELECT ... FOR UPDATE`.
- Không có draft → loopback `POST /api/native-orders/from-comment`.
- Sau COMMIT mới notify SSE `web2:cart` + `web2:native-orders`.
- PSID page-scoped → cross-page resolve qua `fb_id` ∪ `fb_psids`.
- Line shape có `fbCommentId` (khoá để fetch thumbnail snapshot per-dòng).

### 6.4 KPI theo chiến dịch (Web 2.0)

```sql
CREATE TABLE web2_kpi_assignments (   -- gán dải STT → NV theo chiến dịch
    id SERIAL PK, campaign_name VARCHAR(255) UNIQUE, employee_ranges JSONB DEFAULT '[]',
    parent_campaign_id BIGINT, campaign_label VARCHAR(255), updated_at TIMESTAMPTZ);
CREATE UNIQUE INDEX uq_web2_kpi_assign_parent ON web2_kpi_assignments(parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;
CREATE TABLE web2_kpi_events (         -- ledger append-only
    id BIGSERIAL PK, event_time BIGINT, event_type VARCHAR(30),
    beneficiary_user_id INTEGER, beneficiary_source VARCHAR(20),
    order_code VARCHAR(64), order_campaign_stt INTEGER, customer_id VARCHAR(128),
    product_code VARCHAR(64), qty_delta INTEGER, source VARCHAR(20),
    campaign_id VARCHAR(100) NOT NULL, idempotency_key VARCHAR(80) UNIQUE, ...);
```
Tính KPI: `GET /api/web2/kpi/kpi?parent_campaign_id=`:
```
Lọc đơn (union giống /load):
  status <> 'cancelled' AND (parent_campaign_id = $1
    OR fb_post_id IN (SELECT post_id FROM web2_live_post_assign WHERE campaign_id = $1))
Công thức:
  livestream = Σ max(0, qty_hiện_tại − kpi_base)   (chỉ đơn đã chốt)
  inbox      = 100% Σ qty, hưởng = created_by
  tiền = qty × RATE_PER_SP
Beneficiary: resolveBeneficiaryBySTT(campaign_stt, ranges gán theo parent_campaign_id)
```

Snapshot "chốt đơn" (`kpi_base`): cột JSONB per-đơn = `{productCode: Σqty}` tại thời điểm chốt.
Trigger khi tin nhắn khớp regex `/\bchot\s+don\b/`, hoặc admin `POST /:code/lock-kpi-base`. Bất biến sau khi set.

### 6.5 Snapshot ảnh livestream (`livestream_snapshots`)

⚠ Tên bảng KHÔNG có prefix `web2_`. Đây là ẢNH chụp màn hình live per-comment (khác `kpi_base`).
```sql
CREATE TABLE livestream_snapshots (
    id BIGSERIAL PK, comment_id TEXT, customer_fb_user_id TEXT NOT NULL, customer_name TEXT,
    page_id TEXT NOT NULL, page_name TEXT, live_campaign_id TEXT, live_video_id TEXT,
    captured_at BIGINT NOT NULL, captured_by TEXT, offset_seconds INTEGER,
    livestream_url TEXT, thumbnail_url TEXT, note TEXT,
    image_data BYTEA, image_mime VARCHAR(50), image_size INTEGER, extract_status VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW());
CREATE UNIQUE INDEX uq_lss_comment_id ON livestream_snapshots(comment_id);
```
Ảnh chụp client-side (seek iframe VOD → chụp frame), lưu BYTEA, serve qua `GET /api/livestream/snapshot/:id/image` (public).

---

## PHẦN 7 — CHECKLIST TÁI HIỆN THỰC + CÁC BẪY ĐÃ TRẢ GIÁ

**Hạ tầng:**
1. Tách 3 service: WS relay 24/7 · backend API · frontend. Relay và backend nói chuyện bằng
   `x-relay-secret` (fail-closed).
2. Proxy Pancake bắt buộc (CORS + giấu JWT + cookie/referer giả). 3 họ: generic (JWT query),
   direct (JWT cookie), official (PAT query).
3. `image-proxy` PHẢI có allowlist host (chống SSRF).

**Token:**
4. Gom token về Postgres (bỏ Firestore). Auto-refresh bằng health-check `error_code 105/190`,
   KHÔNG tin `exp`. Mã hoá password AES-256-GCM.
5. Pancake trả **HTTP 200 + `success:false`/`error_code`** cho lỗi → luôn check body.

**Comment pipeline:**
6. PUSH-only (WS), KHÔNG polling. Join PER-PAGE (`multiple_pages:` = bẫy err 122).
7. Thống nhất 1 khoá ID comment (khuyến nghị `${postId}_${commentId}`) — bản gốc có 3 kiểu ID gây dedup phức tạp.
8. Delta cursor = `updated_at` + `ORDER BY updated_at ASC` khi có sinceUpdated (nếu không → mất tin vĩnh viễn khi burst).
9. Timezone: Pancake `inserted_at` thiếu `Z` → append bằng regex NEO CUỐI `/(?:Z|[+-]\d{2}:?\d{2})$/`.
   Lưu UTC, hiển thị GMT+7.
10. Reconcile "…" bắt buộc `customer_id` = UUID KHÁCH (không phải PSID).
11. Bài live: field `live_video_status` ('live'|'vod'), KHÔNG phải `live_status`/`is_living`.
12. SSE payload chỉ tickle (KHÔNG PII) — client tự re-fetch.

**Kho KH:**
13. `phone` chỉ `^0\d{9}$` hoặc NULL. Nhận diện = phone chính OR alt_phones (1 hằng số SQL cho mọi đường ghi).
14. Không ghi đè (fill-if-empty), guard TOCTOU trong câu UPDATE.
15. `fb_id` = PSID page-scoped (KHÔNG unique về người); `global_id` = khoá hợp nhất; `fb_psids` canonical `{psid: pageId}`, 1 chokepoint ghi.
16. `status` là MÃ, normalize ở mọi đường ghi.

**Đơn/Giỏ/KPI:**
17. 3 khái niệm campaign tách bạch. `parent_campaign_id` BIGINT (JSON về string → so `String(a)===String(b)`).
18. `campaign_id` ở `web2_live_comments` là VARCHAR nhưng ở `web2_live_post_assign` là BIGINT → mọi JOIN cast `::text`.
19. Giỏ = `native_orders.products` (1 nguồn), `SELECT ... FOR UPDATE`. `:commentId` trong URL cart = fbUserId.
20. Idempotency đơn: `fb_comment_id` unique + cửa sổ 60s theo `(fb_user_id, live_campaign_id)`.
21. Merge draft ATOMIC trong SQL (chống lost-update). Notify SSE SAU commit.

**Lỗi bản gốc đã phát hiện (nên sửa khi port):**
- `cart.js:_resolveWeb2CustomerId` khớp `fb_psids` theo `e.value` (shape cũ `{pageId:psid}`) trong khi
  canonical là `{psid:pageId}` → nhánh fb_psids gần như chết.
- `addWeb2AltPhone` nhánh `fbId` chỉ khớp `fb_id`, không khớp `fb_psids`.
- `GET /:phone` chỉ khớp phone chính, không alt (bất đối xứng với `/batch-by-phone`).
- 4 định nghĩa "tên placeholder" khác nhau → nên gom 1 hằng số.
- Cột `web2_live_comments.data JSONB` và một số POLL_* là code chết.
- Không có cron retention cho `web2_live_comments` → bảng tăng vô hạn (nên thêm).

---

*Tài liệu sinh 2026-08-13 từ khảo sát code thật (6 agent song song đọc render.com/, live-chat/, web2/,
native-orders/). Mọi `file:line` trong bản khảo sát gốc có thể tra chéo nếu cần chi tiết sâu hơn.*
