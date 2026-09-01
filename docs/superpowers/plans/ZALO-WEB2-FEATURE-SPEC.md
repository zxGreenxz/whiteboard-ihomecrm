# Đặc tả kỹ thuật đầy đủ: Tính năng Zalo (Web 2.0 — N2Store)

> **[SPEC THAM CHIẾU HỆ NGOÀI — N2Store/Pancake, KHÔNG mô tả iHomeCRM]** Dùng làm nguồn "bất biến đã trả giá bằng bug" khi port tính năng. Trạng thái port Facebook: thiết kế đã duyệt, chưa triển khai (`docs/superpowers/specs/2026-08-13-facebook-inbox-design.md`).

> **Mục đích**: Tài liệu này mô tả TOÀN BỘ tính năng Zalo trên hệ thống Web 2.0 — cấu trúc dữ liệu, API, service, luồng xử lý, realtime, các bẫy đã gặp — đủ chi tiết để một AI agent khác hiện thực lại tính năng này trên một trang web/hệ thống khác **mà không cần đọc code gốc**.
>
> **Phạm vi**: chat Zalo cá nhân 2 chiều (qua thư viện không chính thức `zca-js`), ZNS/OA chính thức, quản lý nhiều tài khoản, realtime SSE, và các điểm nhúng chat vào trang khác.
>
> **Stack tham chiếu gốc**: Node.js + Express (backend trên Render), Postgres (pool riêng `web2Db`), SSE pub/sub, frontend vanilla JS (script-tag classic, không bundler), Chrome extension (đọc credential Zalo Web).

---

## MỤC LỤC

1. [Kiến trúc tổng thể](#1-kiến-trúc-tổng-thể)
2. [Thư viện & cơ chế auth Zalo](#2-thư-viện--cơ-chế-auth-zalo)
3. [Cấu trúc dữ liệu (Postgres)](#3-cấu-trúc-dữ-liệu-postgres)
4. [REST API đầy đủ](#4-rest-api-đầy-đủ)
5. [Service zca-js (chat cá nhân)](#5-service-zca-js-chat-cá-nhân)
6. [Service OA/ZNS (chính thức)](#6-service-oazns-chính-thức)
7. [Realtime SSE (topic + payload)](#7-realtime-sse)
8. [Chrome Extension (đọc credential)](#8-chrome-extension-đọc-credential)
9. [Frontend — trang quản trị Zalo](#9-frontend--trang-quản-trị-zalo)
10. [Frontend — bộ UI kit chat (WZChat)](#10-frontend--bộ-ui-kit-chat-wzchat)
11. [Lớp cổng chung & nhúng vào trang khác](#11-lớp-cổng-chung--nhúng-vào-trang-khác)
12. [Luồng end-to-end](#12-luồng-end-to-end)
13. [Bẫy & bài học (BẮT BUỘC đọc)](#13-bẫy--bài-học)
14. [Checklist hiện thực lại](#14-checklist-hiện-thực-lại)

---

## 1. Kiến trúc tổng thể

Tính năng Zalo có **1 nguồn duy nhất** (single-source): mọi trang trong hệ thống KHÔNG gọi Zalo trực tiếp, mà đi qua chuỗi lớp sau:

```
┌─────────────────────────────────────────────────────────────┐
│ Trang nghiệp vụ (đơn hàng, kho KH, tra vận đơn…)              │
│   dùng ──►  Web2CustomerChat (drawer/modal 2 tab Pancake+Zalo)│
│              dùng ──► Web2Zalo (cổng công khai)                │
│                        dùng ──► ZaloApi (wrapper HTTP)         │
│                                  dùng ──► WZChat (UI kit chat) │
└─────────────────────────────────────────────────────────────┘
                                   │ HTTP  /api/web2-zalo/*
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Backend Express  routes/web2-zalo.js  (mount /api/web2-zalo)  │
│   ├─ service zca-js   (chat cá nhân, WebSocket realtime)       │
│   ├─ service OA/ZNS   (REST chính thức Zalo)                   │
│   ├─ Postgres web2Db  (web2_zalo_*, web2_zns_*)                │
│   └─ SSE hub Web 2.0  (topic web2:zalo:*)                      │
└─────────────────────────────────────────────────────────────┘
        ▲ credential (cookie/imei/uid)
        │
┌───────┴───────────────┐
│ Chrome Extension       │  đọc phiên chat.zalo.me của user
│ content + background   │
└────────────────────────┘
```

**Hai kênh Zalo song song, khác biệt hoàn toàn:**

| | Kênh CÁ NHÂN (personal) | Kênh OA/ZNS (chính thức) |
|---|---|---|
| Thư viện | `zca-js` (KHÔNG chính thức, reverse-engineer) | REST API chính thức Zalo |
| Auth | cookie + imei + userAgent (giả lập trình duyệt) | OAuth (app_id + secret + access/refresh token) |
| Chat 2 chiều | ✅ có (realtime WebSocket) | ❌ chỉ gửi (ZNS template / tin tư vấn) |
| Realtime nhận tin | ✅ WebSocket listener | ❌ (webhook nếu cấu hình, không dùng ở đây) |
| Rủi ro | Có thể bị Zalo ban / kick phiên | An toàn, tính phí ZNS |
| Dùng cho | Chat KH, nhóm nội bộ, quét dữ liệu | Gửi thông báo đơn hàng theo template |

**Quyết định kiến trúc quan trọng (đã chốt)**: từ mô hình "mỗi máy/trình duyệt 1 tài khoản riêng" (owner-scoped), hệ thống đã đổi sang **1 tài khoản Zalo cá nhân dùng chung toàn dự án** (`owner = '__global__'`), server tự giữ phiên 24/7 (always-on). Toàn bộ plumbing owner-scoped vẫn còn trong code nhưng bị ép về hằng số `'__global__'`. **Khi hiện thực lại: nếu không cần multi-tenant per-máy, có thể BỎ hoàn toàn lớp owner-scoped.**

---

## 2. Thư viện & cơ chế auth Zalo

### 2.1 Package

- **`zca-js`** `^2.1.2` — thư viện KHÔNG chính thức, giả lập Zalo Web client qua WebSocket. Require kiểu phòng thủ (`try { require('zca-js') } catch {}`) để server không crash nếu lib lỗi; nếu lỗi thì mọi thao tác kênh cá nhân bị chặn (cờ `isAvailable() = false`).
  - Export dùng: `Zalo` (class), `ThreadType` (enum User/Group), `Reactions` (enum icon).
- **`express`** `^4.18.2`.
- OA/ZNS dùng `fetch` built-in Node (không thư viện HTTP riêng).

### 2.2 Kênh cá nhân — auth (zca-js)

- **Cookie import** (chính): `{ cookie, imei, userAgent, language: 'vi' }` lấy từ phiên `chat.zalo.me` đang đăng nhập trên trình duyệt (qua extension). Gọi `zalo.login(credentials)`.
  - `imei` = device uuid của Zalo Web, công thức `uuid + '-' + MD5(userAgent)` (zca-js tự tính; extension chỉ cung cấp uuid gốc từ `localStorage['z_uuid']` + userAgent).
- **QR code** (thay thế): `zalo.loginQR({ language: 'vi' }, onEvent)`. Callback `onEvent` nhận `ev.type`:
  - `0` = QRCodeGenerated (`ev.data.image` = base64 PNG)
  - `1` = Expired
  - `2` = Scanned (`ev.data.display_name`, `ev.data.avatar`)
  - `3` = Declined
  - `4` = GotLoginInfo (thành công)
- **Không có OAuth / refresh token** — session (`zpw_sek`) tự hết hạn ~7 ngày → phải "proactive re-login" chủ động trong cửa sổ này (xem [§5.5](#55-watchdog--giữ-phiên-không-bị-văng)).
- **Realtime**: `api.listener` (WebSocket) phát các event: `message`, `reaction`, `undo`, `typing`, `seen_messages`, `delivered_messages`, `group_event`, plus `onConnected` / `onClosed` / `onError`.

### 2.3 Kênh OA/ZNS — REST endpoints chính thức

| Việc | Method + URL | Auth header |
|---|---|---|
| Đổi access_token (OAuth) | `POST https://oauth.zaloapp.com/v4/oa/access_token` (form-urlencoded) | `secret_key` |
| Gửi ZNS theo template | `POST https://business.openapi.zalo.me/message/template` (JSON) | `access_token` |
| Liệt kê template | `GET https://business.openapi.zalo.me/template/all?offset=0&limit=100&status=1` | `access_token` |
| Tin tư vấn (customer service) | `POST https://openapi.zalo.me/v3.0/oa/message/cs` (JSON) | `access_token` |

> OA dùng header `secret_key` (OAuth) và `access_token` (business API), **KHÔNG** `Authorization: Bearer`.

---

## 3. Cấu trúc dữ liệu (Postgres)

Tất cả bảng ở pool **`web2Db`** (tách riêng, KHÔNG dùng chung DB với phần còn lại). Hàm `ensureZaloSchema(pool)` chạy mỗi boot, idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`), dùng `WeakSet` để không chạy 2 lần trên cùng pool object.

Thời gian lưu dạng **epoch milliseconds (BIGINT)**, không dùng TIMESTAMPTZ. Hiển thị convert sang GMT+7 ở tầng UI.

### 3.1 `web2_zalo_accounts` — tài khoản (cả personal lẫn OA trong 1 bảng)

```sql
CREATE TABLE web2_zalo_accounts (
  id            BIGSERIAL PRIMARY KEY,
  account_key   VARCHAR(80) UNIQUE NOT NULL,   -- personal: 'zca_'+uuid | oa: oa_id
  account_type  VARCHAR(10) NOT NULL DEFAULT 'personal', -- 'personal' | 'oa'
  label         VARCHAR(255),
  zalo_uid      VARCHAR(100),                  -- uid tài khoản (personal)
  oa_id         VARCHAR(80),
  display_name  VARCHAR(255),
  avatar_url    TEXT,
  session       JSONB,                         -- {cookie,imei,userAgent,language} — MÃ HOÁ at-rest
  proxy_url     TEXT,
  app_id        VARCHAR(80),                   -- (oa)
  oa_secret     TEXT,                          -- (oa) MÃ HOÁ
  access_token  TEXT,                          -- (oa) MÃ HOÁ
  refresh_token TEXT,                          -- (oa) MÃ HOÁ, XOAY mỗi lần refresh
  token_expires BIGINT,                        -- epoch ms
  status        VARCHAR(20) NOT NULL DEFAULT 'disconnected',
    -- disconnected|qr_pending|scanned|connected|banned|error|token_ok|connecting|reconnecting|kicked|yielded
  status_msg    TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_primary    BOOLEAN NOT NULL DEFAULT false, -- LEGACY, không còn dùng
  owner_id      VARCHAR(80),                    -- luôn = '__global__'
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at BIGINT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX idx_web2_zalo_acc_type   ON web2_zalo_accounts(account_type);
CREATE INDEX idx_web2_zalo_acc_active ON web2_zalo_accounts(is_active);
CREATE INDEX idx_web2_zalo_acc_oa     ON web2_zalo_accounts(oa_id) WHERE oa_id IS NOT NULL;
CREATE INDEX idx_web2_zalo_acc_owner  ON web2_zalo_accounts(owner_id);
```

- Sau CREATE: `UPDATE ... SET owner_id='__global__' WHERE owner_id IS NULL OR owner_id <> '__global__'` (backfill mô hình global).
- Cột nhạy cảm (`session`, `oa_secret`, `access_token`, `refresh_token`) **mã hoá at-rest** bằng AES-256-GCM (bật khi có env khoá; tắt = plaintext, tự nhận diện ciphertext để không lock-out — xem [§13.10](#13-bẫy--bài-học)).

### 3.2 `web2_zalo_conversations` — 1 dòng / (account × thread)

```sql
CREATE TABLE web2_zalo_conversations (
  id            BIGSERIAL PRIMARY KEY,
  account_key   VARCHAR(80) NOT NULL,
  thread_id     VARCHAR(100) NOT NULL,          -- uid KH (1-1) | group id
  thread_type   VARCHAR(10) NOT NULL DEFAULT 'user', -- 'user' | 'group'
  zalo_uid      VARCHAR(100),
  display_name  VARCHAR(255),
  avatar_url    TEXT,
  customer_id   BIGINT,                          -- FK mềm → kho KH (không constraint)
  phone         VARCHAR(20),
  last_msg_at   BIGINT,
  last_msg_text TEXT,
  unread_count  INTEGER NOT NULL DEFAULT 0,
  last_read_msg_id TEXT,
  last_read_at  BIGINT,
  is_pinned     BOOLEAN NOT NULL DEFAULT false,
  is_muted      BOOLEAN NOT NULL DEFAULT false,
  muted_until   BIGINT,
  last_msg_sender_uid VARCHAR(100),              -- 'me' = shop
  info_synced_at BIGINT,                         -- TTL gate resolve tên/avatar
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE (account_key, thread_id)
);
CREATE INDEX idx_web2_zalo_conv_acc      ON web2_zalo_conversations(account_key);
CREATE INDEX idx_web2_zalo_conv_uid      ON web2_zalo_conversations(zalo_uid);
CREATE INDEX idx_web2_zalo_conv_phone    ON web2_zalo_conversations(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_web2_zalo_conv_customer ON web2_zalo_conversations(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_web2_zalo_conv_last     ON web2_zalo_conversations(last_msg_at DESC NULLS LAST);
```

### 3.3 `web2_zalo_messages` — append-only

```sql
CREATE TABLE web2_zalo_messages (
  id            BIGSERIAL PRIMARY KEY,
  msg_id        TEXT,          -- id Zalo (dedup; nullable — 1 số event realtime không có)
  cli_msg_id    TEXT,          -- client msg id (cần cho recall/react/seen/dedup gửi)
  account_key   VARCHAR(80) NOT NULL,
  thread_id     VARCHAR(100) NOT NULL,
  thread_type   VARCHAR(10) NOT NULL DEFAULT 'user',
  direction     VARCHAR(10) NOT NULL,  -- 'in' | 'out' | 'system'
  msg_type      VARCHAR(30) NOT NULL DEFAULT 'text',
    -- text|image|gif|sticker|video|voice|file|link|location|contact|attachment|system|zns|template
  content       TEXT,
  attachments   JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_msg_id  TEXT,
  reply_to_preview TEXT,
  reactions     JSONB NOT NULL DEFAULT '{}'::jsonb, -- {emoji: [uid,...]}
  recalled      BOOLEAN NOT NULL DEFAULT false,
  recalled_at   BIGINT,
  recalled_by   VARCHAR(100),
  hidden_for_me BOOLEAN NOT NULL DEFAULT false,     -- xoá phía mình
  seen_at       BIGINT,
  sender_uid    VARCHAR(100),
  send_status   VARCHAR(20) DEFAULT 'sent',         -- sent|failed|pending
  error_msg     TEXT,
  sent_at       BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);
-- Dedup: partial unique index (chỉ khi msg_id có giá trị)
CREATE UNIQUE INDEX uq_web2_zalo_msg_id ON web2_zalo_messages(account_key, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX idx_web2_zalo_msg_thread ON web2_zalo_messages(account_key, thread_id, sent_at DESC);
CREATE INDEX idx_web2_zalo_msg_failed ON web2_zalo_messages(send_status) WHERE send_status = 'failed';
CREATE INDEX idx_web2_zalo_msg_reply  ON web2_zalo_messages(reply_to_msg_id) WHERE reply_to_msg_id IS NOT NULL;
```

> ⚠ Unique index chỉ áp dụng khi `msg_id IS NOT NULL`. Tin realtime double-fire không có `msg_id` sẽ KHÔNG dedup được qua `ON CONFLICT` → cố ý **chỉ cộng `unread_count` khi `isNew && direction='in' && msg.msgId`** (xem [§13.11](#13-bẫy--bài-học)).

### 3.4 `web2_zalo_media` — self-host bytea cho ảnh/file SHOP GỬI

Lý do: zca-js upload ảnh lên CDN Zalo nhưng KHÔNG trả URL về → phải lưu bản copy để UI hiển thị lại ảnh đã gửi sau reload.

```sql
CREATE TABLE web2_zalo_media (
  id          BIGSERIAL PRIMARY KEY,
  account_key VARCHAR(80),
  mime        VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
  filename    VARCHAR(255),
  data        BYTEA NOT NULL,
  width       INTEGER, height INTEGER, size INTEGER,
  created_at  BIGINT NOT NULL,
  token       VARCHAR(48)     -- token bất khả đoán chống IDOR
);
CREATE INDEX idx_web2_zalo_media_created ON web2_zalo_media(created_at DESC);
CREATE UNIQUE INDEX idx_web2_zalo_media_token ON web2_zalo_media(token) WHERE token IS NOT NULL;
```

### 3.5 `web2_zalo_members` — cache tên/avatar theo uid (composite PK)

```sql
CREATE TABLE web2_zalo_members (
  account_key  VARCHAR(80) NOT NULL,
  uid          VARCHAR(100) NOT NULL,
  display_name VARCHAR(255),
  avatar       TEXT,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (account_key, uid)
);
```

Dùng resolve tên người gửi trong NHÓM (group message thường không kèm tên → gọi `getGroupMembersInfo`).

### 3.6 `web2_zalo_tracked_groups` — allowlist nhóm theo dõi (opt-in, MẶC ĐỊNH TẮT)

```sql
CREATE TABLE web2_zalo_tracked_groups (
  account_key VARCHAR(80) NOT NULL,
  thread_id   VARCHAR(100) NOT NULL,
  name        VARCHAR(255),
  added_at    BIGINT NOT NULL,
  PRIMARY KEY (account_key, thread_id)
);
```

Filter chỉ BẬT khi `ENV_GROUP_ALLOWLIST=1` **và** bảng có ≥1 row. Mặc định TẮT → lưu TẤT CẢ hội thoại (giống app Zalo thật).

### 3.7 `web2_zns_templates` — cache template ZNS từ OA

```sql
CREATE TABLE web2_zns_templates (
  id BIGSERIAL PRIMARY KEY,
  template_id VARCHAR(80) UNIQUE NOT NULL,
  oa_id VARCHAR(80),
  template_name VARCHAR(255) NOT NULL,
  template_quality VARCHAR(20),
  status VARCHAR(20) DEFAULT 'ENABLE',
  params JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name,require,type}]
  preview_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX idx_web2_zns_tpl_oa     ON web2_zns_templates(oa_id);
CREATE INDEX idx_web2_zns_tpl_active ON web2_zns_templates(is_active);
```

### 3.8 `web2_zns_log` — log mỗi lần gửi ZNS (append-only)

```sql
CREATE TABLE web2_zns_log (
  id BIGSERIAL PRIMARY KEY,
  log_id TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  oa_id VARCHAR(80),
  template_id VARCHAR(80) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  customer_id BIGINT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|sent|failed
  zalo_msg_id TEXT,
  quota_cost INTEGER,
  order_ref VARCHAR(80),   -- khoá idempotency chống gửi trùng
  error_msg TEXT,
  sent_by VARCHAR(100),
  sent_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_web2_zns_log_phone   ON web2_zns_log(phone);
CREATE INDEX idx_web2_zns_log_status  ON web2_zns_log(status);
CREATE INDEX idx_web2_zns_log_ref     ON web2_zns_log(order_ref) WHERE order_ref IS NOT NULL;
CREATE INDEX idx_web2_zns_log_created ON web2_zns_log(created_at DESC);
```

### 3.9 `web2_zalo_send_jobs` + `web2_zalo_send_items` — bulk send (⚠ schema có, CHƯA implement xử lý)

Schema được tạo sẵn cho tính năng "gửi hàng loạt" nhưng **KHÔNG có route/worker nào xử lý** (chưa implement). Chỉ tái dùng shape nếu cần.

```sql
CREATE TABLE web2_zalo_send_jobs (
  id BIGSERIAL PRIMARY KEY, job_id TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  account_key VARCHAR(80), job_type VARCHAR(30) NOT NULL DEFAULT 'zns', -- zns|chat
  template_id VARCHAR(80), params_base JSONB NOT NULL DEFAULT '{}'::jsonb, message TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|running|done|failed|cancelled
  total INT NOT NULL DEFAULT 0, sent INT NOT NULL DEFAULT 0, failed INT NOT NULL DEFAULT 0,
  created_by VARCHAR(100), started_at BIGINT, finished_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE web2_zalo_send_items (
  id BIGSERIAL PRIMARY KEY, job_id TEXT NOT NULL,
  phone VARCHAR(20), thread_id VARCHAR(100), customer_id BIGINT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|sent|failed|skip
  zalo_msg_id TEXT, error_msg TEXT, sent_at BIGINT, created_at BIGINT NOT NULL
);
```

### 3.10 Cột thêm vào bảng KHO KHÁCH HÀNG (nếu tích hợp)

Bảng khách hàng chung (`web2_customers` ở hệ gốc) có thêm:
- `zalo_uid VARCHAR(100)`
- `zalo_followed_oa BOOLEAN DEFAULT false`

Cho phép gộp identity Zalo vào hồ sơ KH theo SĐT.

---

## 4. REST API đầy đủ

Base: `/api/web2-zalo`. Toàn bộ router qua middleware **`requireAuthSoft`** (soft gate: chặn 401 chỉ khi `ENV_AUTH_ENFORCE=1`, ngược lại chỉ cảnh báo). Các route đổi trạng thái tài khoản (login/tạo/xoá) thêm **`requireAdmin`**.

`getDb(req) = web2Db || fallback` — luôn dùng pool Web 2.0.

### 4.0 Cơ chế chung xuyên suốt

**Idempotency gửi tin** (`withSendGuard(accountKey, threadId, cliMsgId, handler)`): dùng in-process `Map` `sendInflight` (đang chạy) + `sendDone` (đã xong, TTL 60s) khoá theo `${accountKey}|${threadId}|${cliMsgId}`. Double-click / retry cùng `cliMsgId` KHÔNG gọi zca lần 2, trả kết quả cũ với `duplicate:true`. Không có `cliMsgId` → gửi bình thường.

**SSE notify**: `notify(topic, action, code)` → `notifyClients(topic, {action, code, ts}, 'update')`. Hàm `notifyClients` inject từ tầng server qua `initializeNotifiers(fn)`.

**`safeAccount(a)`**: strip dữ liệu nhạy cảm trước khi trả client — KHÔNG bao giờ trả `session`/`access_token`/`refresh_token`/`oa_secret` thô, chỉ trả boolean `hasSession`/`hasToken`; `proxyUrl` → `'••• đã set'` hoặc null. Gộp thêm `health` (healthy/reconnecting/lastEventAt/lastCloseCode/consecutiveKicks/connectedAt) cho UI đèn sức khoẻ.

### 4.1 Status & Accounts

| Method + Path | Auth | Body/Query | Logic | Response |
|---|---|---|---|---|
| `GET /status` | soft | — | list account (`is_active=true AND (type='oa' OR owner=$)`) | `{success, zcaAvailable, accounts[], personalCount, oaCount}` |
| `GET /accounts` | soft | — | như trên, không filter active | `{success, accounts[]}` |
| `POST /accounts` | admin | `{label}` | tạo shell personal `account_key='zca_'+uuid`, `status='disconnected'` → notify `accounts:create` | `safeAccount` |
| `POST /accounts/:key/login-cookie` | admin | `{cookie, imei, userAgent}` | stamp owner, `zca.loginWithCredentials(key, {cookie,imei,userAgent,language:'vi'}, label, {expectedUid})`. `expectedUid` = `zalo_uid` cũ (guard `WRONG_ACCOUNT`) | `{success, status:'connected'}` |
| `POST /accounts/:key/login-qr` | admin | — | **fire-and-forget**; push event qua SSE `web2:zalo:qr:<key>` | `{success, started, topic}` |
| `POST /accounts/:key/disconnect` | admin | — | `zca.disconnect` + `status='disconnected'` + notify | `{success}` |
| `DELETE /accounts/:key` | admin | — | `zca.disconnect` + DELETE row + notify `deleted` | `{success}` |
| `GET /accounts/:key/self` | soft | — | `zca.fetchSelf` (live) | thông tin tài khoản |
| `GET /accounts/:key/friends` | soft | — | `zca.getAllFriends` | danh sách bạn |
| `GET /accounts/:key/groups` | soft | — | `zca.getAllGroups` | danh sách nhóm |
| `POST /accounts/:key/sync-conversations` | soft | — | `zca.getRoster` (bạn+nhóm) → UPSERT `web2_zalo_conversations` | `{success, count}` |
| `POST /accounts/:key/repair-group-names` | soft | — | `repairConvNames(key)` thủ công | `{success}` |

> ⚠ zca-js KHÔNG có API "liệt kê hội thoại gần đây". Chỉ seed được từ bạn bè + nhóm. **KH lạ chỉ xuất hiện qua realtime listener kể từ lúc kết nối.**

### 4.2 Lookup

| `GET /lookup?accountKey&phone|uid` | soft | — | có `uid` → `zca.getUserInfo`; có `phone` → `zca.findUser` (strip non-digit) | thông tin user |

### 4.3 Conversations & Messages (đọc từ DB, lazy-heal qua zca)

**`GET /conversations?accountKey&search&page&limit`** — filter theo owner; `search` ILIKE trên `display_name`/`phone`/`zalo_uid`. Trả kèm `last_sender_name` (LEFT JOIN members). Nếu account connected → resolve tên người-gửi-cuối còn thiếu cho nhóm (1 batch `getGroupMembersInfo`). → `{success, data, total}`.

**`GET /conversations/:id/messages?limit&before&beforeId`** — keyset pagination composite `(sent_at, id)` DESC:
- **Lazy heal tên/avatar** (TTL 6h, gate qua `info_synced_at`, timeout mỗi call zca 2s):
  - `thread_type='user'`: `zca.getUserInfo(accountKey, thread_id)` — **LUÔN dùng `thread_id`** (= uid KHÁCH), KHÔNG dùng cột `zalo_uid` (có thể bị nhiễm uid shop). Force ghi đè `display_name`/`avatar_url`/`zalo_uid=thread_id`.
  - `thread_type='group'`: `zca.getGroupsInfo(accountKey, [thread_id])`.
  - Lỗi/timeout → KHÔNG stamp `info_synced_at` (retry lần sau).
- Query: `... WHERE account_key=$1 AND thread_id=$2 AND NOT COALESCE(hidden_for_me,false) ORDER BY sent_at DESC, id DESC LIMIT $n`.
- Nếu mở mới (`!before`) → reset `unread_count=0` + cập nhật `last_read_*`.
- Nếu nhóm → `attachGroupSenders` gắn `sender_name`/`sender_avatar` (tin shop map về label 'Bạn').
- → `{success, conversation, data: rows.reverse(), hasMore}`.

**`POST /conversations/:id/backfill`** — `{count}` (max 500, default 200). CHỈ nhóm. `zca.getGroupHistory(accountKey, threadId, count)` → INSERT dedupe (chỉ tin có `msg_id`), KHÔNG bump unread/last_msg. Sau đó fire-and-forget quét mã vận đơn. ⚠ zca-js chỉ trả **batch gần nhất**, `more>0` báo còn tin cũ nhưng **không có cursor lấy tiếp** (trần cứng).

**`GET /conversations/:id/members`** — chỉ nhóm. Gộp (1) người đã nhắn trong thread + (2) `zca.getGroupMembers`. Cho dropdown @mention. Chỉ trả member có tên.

**`GET /conversation/:phone`** — tra hội thoại 1-1 theo SĐT (dùng bởi cổng chung). Ưu tiên `?account=`, fallback account connected.

**`POST /conversation/ensure`** — `{phone, accountKey?}`. Có sẵn → trả luôn. Chưa: cần account connected (không → 400 `needLogin:true`). `zca.findUser(accountKey, phone)` → có uid → INSERT conversation mới `thread_type='user'`.

### 4.4 Gửi tin — kênh cá nhân (zca)

Helper `persistOut(db, p)`: INSERT message (direction='out', dedup theo msg_id) + UPDATE conversation (`last_msg_at`, `last_msg_text`, `last_msg_sender_uid='me'`) + notify.

| Method + Path | Body | Logic |
|---|---|---|
| `POST /send-message` | `{accountKey, threadId, text, threadType, replyTo?, mentions?, cliMsgId?}` | `withSendGuard`; `replyTo.quote` = raw quote object pass thẳng zca; `mentions=[{uid,pos,len}]`. Nếu Zalo từ chối quote → gửi lại KHÔNG quote (`quoteDropped:true`). → `{success, duplicate, msgId, cliMsgId, id, sentAt}` |
| `POST /send-image` | `{accountKey, threadId, threadType, caption, files:[{base64,mime,filename,width,height}], cliMsgId}` | ≤12 file. Mỗi file: decode → lưu bytea `web2_zalo_media` (token random) → build URL → `zca.sendMedia` (upload thật) → `persistOut` với `attachments:[{type:'image',url,thumb,title}]` |
| `POST /send-file` | như trên, 1 file | `msg_type='file'` |
| `POST /send-sticker` | `{accountKey, threadId, threadType, sticker:{id,cateId,type,url?}, cliMsgId}` | `zca.sendSticker` |
| `POST /react` | `{accountKey, threadId, msgId, cliMsgId, icon, threadType}` | `icon` = key enum (HEART/LIKE/HAHA/WOW/CRY/ANGRY). `zca.react` rồi tự `persistReaction({uidFrom:'me', icon})` (reaction shop không đến qua listener) |
| `POST /recall` | `{accountKey, threadId, msgId, cliMsgId, threadType}` | thu hồi 2 phía, `recalled=true` |
| `POST /delete-message` | `{accountKey, threadId, msgId, cliMsgId, uidFrom, threadType}` | `zca.deleteForMe` (onlyMe), `hidden_for_me=true` (khớp msg_id HOẶC cli_msg_id) |
| `POST /forward` | `{accountKey, message, threadIds[], threadType}` | chuyển tiếp nhiều thread (không lưu bản ghi out riêng) |
| `POST /typing` | `{accountKey, threadId, threadType}` | best-effort, luôn `{success:true}` |
| `POST /seen` | `{accountKey, convId, threadId, threadType}` | `unread_count=0` + best-effort `zca.sendSeen` (idTo=threadId) |

### 4.5 Quản lý hội thoại (DB-driven, không gọi zca)

| `POST /conversations/:id/pin` | `{pinned}` | notify topic bare `web2:zalo:messages` |
| `POST /conversations/:id/mute` | `{muted, until?}` (epoch, null=vô hạn) | |
| `POST /conversations/:id/mark` | `{unread}` | đánh dấu đã/chưa đọc thủ công |

### 4.6 Sticker / Quick reply

| `GET /stickers?accountKey&q` | `zca.getStickers` (keyword→id→detail, url webp) |
| `GET /quick-replies?accountKey` | `zca.getQuickMessages` |
| `POST /quick-replies` | `{accountKey, keyword, title}` → `zca.addQuickMessage` (lưu THẲNG trên Zalo, không DB) |

### 4.7 Serve media tự host

**`GET /media/:id`** — 2 chế độ: (a) `id` không phải số → coi là `token` (chống enumerate) → `WHERE token=$1`; (b) `id` là số (legacy) → BẮT BUỘC `?accountKey=` để scope, thiếu → 404. Header `Cache-Control: private, max-age=31536000, immutable`. Nằm SAU auth gate.

> `MEDIA_BASE` (URL nhúng vào `attachments`) nên là **domain ổn định/host-agnostic** (đổi host sẽ vỡ link ảnh cũ đã lưu vĩnh viễn trong DB). Override bằng `ENV_MEDIA_BASE`.

### 4.8 OA — ZNS + tin tư vấn

| `POST /oa/connect` | `{appId, secret, code, oaId, oaName, accountKey}` | `oa.exchangeCode` (authorization_code) + `syncTemplates` best-effort |
| `POST /oa/sync-templates` | `{oaRef}` | đồng bộ template |
| `GET /zns/templates` | — | template active từ cache DB |
| `POST /send-zns` | `{phone, templateId, data, orderRef, oaRef, customerId, sentBy}` | **rate-limit route-level: 5/SĐT/60s** (429 nếu vượt) → `oa.sendZNS` (idempotency theo `orderRef` ở service) |
| `POST /oa/send-cs` | `{oaRef, userId, text}` | tin tư vấn tới user đã từng chat OA (không phí ZNS) |
| `GET /zns/log?phone&status&page&limit` | — | lịch sử gửi ZNS |

### 4.9 Tracked groups (allowlist) — CRUD

`GET /tracked-groups`, `POST /tracked-groups` (`{accountKey, threadId, name}`), `DELETE /tracked-groups/:accountKey/:threadId` — mỗi thao tác refresh cache in-memory + notify.

### 4.10 Admin reset (nguy hiểm)

**`POST /admin/reset-to-tracked`** — cần `requireAdmin` + header `x-admin-secret` khớp `ENV_CLEANUP_SECRET` (sai → 403). Body `{pattern?, groups?, confirm, dryRun?}`. Không có `confirm:'YES-RESET'` hoặc `dryRun=true` → chỉ preview. Khi confirm: seed nhóm vào tracked_groups → **DELETE TOÀN BỘ** 4 bảng chat (messages/conversations/media/members, không WHERE) → tái tạo conversation rỗng cho nhóm được khoá. GIỮ: accounts + ZNS.

### 4.11 Focus-lease (route còn nhưng LOGICALLY NO-OP)

`POST /accounts/:key/lease`, `POST /accounts/:key/release` — giữ để trang cũ gọi không 404, nhưng `releaseLease` giờ luôn no-op (mô hình always-on). **Có thể bỏ khi hiện thực lại.**

---

## 5. Service zca-js (chat cá nhân)

### 5.1 State in-memory

`sessions: Map<accountKey, { api, listener, status, qr, info:{uid,name,avatar}, lastError, creds:{cookie,imei,userAgent,language}, label, expectedUid, connectedAt, lastEventAt, lastCloseCode, reconnecting, reconnectAttempt, consecutiveKicks, reconnectTimer, disposed, yielded, gaveUp, connecting }>`.

**Toàn bộ sống trong RAM process** (trừ cột `session` DB dùng boot-restore). Không cache Redis.

### 5.2 Đăng nhập

- **`loginWithCredentials(accountKey, credentials, label, opts)`**: guard chống double-login (sentinel `connecting`), `new Zalo({selfListen:true, checkUpdate:false, logging:false})` → `zalo.login(credentials)` → `afterLogin`.
- **`loginWithQR(accountKey, label, onEvent, opts)`**: `zalo.loginQR({language:'vi'}, onEvent)` → `afterLogin`.
- **`afterLogin(accountKey, api, label, opts)`**:
  1. `ctx = api.getContext()` → `credentials = {imei, userAgent, language, cookie: ctx.cookie.toJSON().cookies || ctx.cookie}`.
  2. `self = await api.fetchAccountInfo()` → uid/displayName/avatar.
  3. **Guard `WRONG_ACCOUNT`**: slot có `expectedUid` cũ mà uid mới KHÁC → xoá session, throw (chặn gắn nhầm phiên trình duyệt vào slot khác).
  4. Callback `persistSession(accountKey, credentials, info, label)` (mã hoá + ghi DB).
  5. `attachListener(accountKey, api)`.
  6. `setStatus('connected')`, lưu creds RAM, reset counters, `startWatchdog()`.
  7. Callback `onConnected(accountKey)` (route dùng để `repairConvNames`).

### 5.3 Listener realtime (`attachListener`)

Đăng ký event ĐÚNG tên zca-js v2.1.2: `message`, `reaction`, `undo`, `typing`, `seen_messages`, `delivered_messages`, `group_event`. Mỗi handler bọc `bumpEvent` (cập nhật `lastEventAt` cho watchdog) + try/catch:
- `message` → `normMessage` → callback `onMessage` → route `persistIncoming`.
- `reaction` → `normReaction` → `onReaction`.
- `undo` → `normUndo` → `onUndo` (thu hồi).
- `typing` → `normTyping` → `onTyping`.
- `seen_messages` / `delivered_messages` → `normSeen` → `onSeen`/`onDelivered`.
- `group_event` → `normGroupEvent` (join/leave/remove/add_admin/update… → câu tiếng Việt; loại khác → null bỏ qua) → đi qua `onMessage` như tin `direction:'system'`, `msg_id:'sys_<threadId>_<type>_<ts>'`.
- `onConnected` → bump + `setStatus('connected')`.
- `onClosed(code, reason)` → nếu `yielded/disposed` bỏ qua; else `setStatus('disconnected')` + `scheduleReconnect(key, code)`.
- `onError(err)` → `scheduleReconnect(key, 1006)`.

### 5.4 Chuẩn hoá message (`normMessage`)

- **`classifyMsgType`**: `webchat→text`, `chat.photo→image`, `chat.gif→gif`, `chat.sticker→sticker`, `chat.video.msg→video`, `chat.voice→voice`, `share.file→file`, `chat.link→link`, `chat.location.new→location`, `chat.recommended→contact`, `chat.doodle→image`, default→`attachment`.
- **`extractAttachment`**: URL ưu tiên `content.href || params.normalUrl || hdUrl || oriUrl || url || content.thumb || thumbUrl`. Riêng `contact` (uid/phone/title/avatar/href=qrCodeUrl), `location` (lat/lon/title/href=Google Maps link tự build).
- `quote` (reply): từ `d.quote.{msgId|globalMsgId|cliMsgId}` + content slice 120 ký tự + `fromD`/`dName`.
- Trả object chuẩn: `{accountKey, msgId, cliMsgId, threadId, threadType, direction('in'|'out' theo m.isSelf), msgType, content, attachments[], replyTo, senderUid, senderName, sentAt, raw}`.

**Reaction mapping 2 chiều**: giá trị Zalo trả về (`/-heart`, `:>`...) khác enum gửi đi (`HEART`, `LIKE`...) → 2 bảng map (`ZCA_VALUE_EMOJI` nhận vào, `REACTION_EMOJI` gửi ra), cả hai convert về emoji Unicode để lưu thống nhất trong `reactions` JSONB. Reaction lưu ATOMIC bằng 1 UPDATE `jsonb_set` + `array_agg DISTINCT` dưới row lock (tránh mất khi 2 event tới gần nhau). **Add-only** (zca-js không hỗ trợ gỡ reaction).

### 5.5 Watchdog — giữ phiên không bị văng

Constants (nghiên cứu từ zca-js issues):
- `KEEPALIVE_TIMEOUT_MS = 8000`
- `WATCHDOG_MS = 90000` (chu kỳ tick)
- `PROACTIVE_RELOGIN_MS = 3.5 ngày` (re-login chủ động trước khi `zpw_sek` ~7 ngày hết hạn)
- `RECONNECT_BACKOFF_MS = [5000,15000,30000,60000,120000]` (lỗi mạng/1006)
- `KICK_RECONNECT_MS = 30000` (bị đá 3000/3003)
- `KICK_CAP = 4`, `KICK_COOLDOWN_MS = 10 phút`
- `RECONNECT_COOLDOWN_MS = 3000` (chờ WS cũ đóng hẳn tránh tự-kick)
- `MAX_RECONNECT_ATTEMPTS = 10` (sau đó `gaveUp=true`, chờ login tay)

**`watchdogTick()`** (mỗi 90s, mọi session): bỏ qua nếu `disposed/reconnecting/yielded`; re-login chủ động nếu quá `PROACTIVE_RELOGIN_MS`; có `api` → `api.keepAlive()` timeout race 8s (lỗi → `scheduleReconnect(1006)`); không có `api` nhưng có `creds` chưa `gaveUp` → schedule reconnect.

**`scheduleReconnect(key, code)`**: bỏ qua nếu `!creds` hoặc đã có timer. `code ∈ {3000,3003}` (DuplicateConnection/KickConnection = bị giành phiên) → tăng `consecutiveKicks`, vượt `KICK_CAP` → `status='kicked'` nghỉ 10 phút; chưa vượt → 30s. Code khác → backoff luỹ thừa, vượt `MAX_RECONNECT_ATTEMPTS` → `gaveUp`.

**`doReconnect(key)`**: đóng listener cũ, chờ 3s, `loginWithCredentials(key, creds, label, {expectedUid})`.

**`stopAll()`** (graceful shutdown SIGTERM/SIGINT): đánh dấu mọi session `disposed`, huỷ timer, đóng listener — nhường phiên cho instance mới lúc deploy (tránh 2 instance "đấu" phiên → kick 3000/3003).

### 5.6 Lưu phiên + boot-restore

- **`persistSession` → `saveSession`**: UPDATE cột `session = encryptJson(credentials)` (COALESCE giữ cũ nếu credentials null), cùng `zalo_uid`/`display_name`/`avatar_url`/`status='connected'`/`last_connected_at`.
- **`restoreSessions()`** (boot, sau `ensureSchema`, chỉ khi jobs bật): `SELECT ... WHERE account_type='personal' AND is_active AND session IS NOT NULL` → `decryptJson(session)` → nếu đủ `{cookie,imei,userAgent}` → `loginWithCredentials` (best-effort, lỗi 1 account không chặn account khác).

### 5.7 Các action khác (đều `requireApi` trước)

`send` (string hoặc `{msg, quote?, mentions?}`; quote bị từ chối → gửi lại không quote), `sendMedia` (`sources=[{data:Buffer, filename, metadata:{totalSize,width?,height?}}]`, chung cho ảnh+file), `sendSticker`, `react`, `recall` (`api.undo`), `deleteForMe` (`api.deleteMessage(onlyMe=true)`), `forward`, `sendTyping`, `sendSeen`, `getStickers`, `getQuickMessages`/`addQuickMessage`, `getUserInfo`, `findUser`, `getMultiUsersByPhones`, `getAllFriends`, `getAllGroups`, `getRoster` (bạn+nhóm), `getGroupHistory`, `getGroupMembersInfo`, `getGroupsInfo` (throw khi lỗi để caller không stamp TTL sai), `getGroupMembers`, `getOwnUid`, `isConnected`, `disconnect`, `status`/`statusAll`.

---

## 6. Service OA/ZNS (chính thức)

### 6.1 Token lifecycle

- `loadOaAccount(pool, ref)` — tìm theo `account_key` HOẶC `oa_id`. `loadDefaultOa` — OA active mới nhất.
- **`refreshToken`** — **dedup theo Promise trong Map `refreshInFlight`** (khoá `account_key||id`): Zalo XOAY `refresh_token` mỗi lần dùng → gọi song song sẽ vô hiệu token cũ → OA khoá tới khi auth lại. Mọi caller đồng thời chờ CÙNG 1 promise.
- `doRefresh` — POST OAUTH_URL header `secret_key`, body form `refresh_token, app_id, grant_type=refresh_token`. LUÔN lưu `refresh_token` mới (fallback giữ cũ).
- `exchangeCode(pool, {accountKey, appId, secret, code, oaId, oaName})` — kết nối OA lần đầu (authorization_code), UPSERT accounts (`ON CONFLICT (account_key) DO UPDATE`).
- `getValidToken(pool, ref)` — tự refresh nếu hết hạn trong `TOKEN_SKEW_MS=60s`.

### 6.2 `sendZNS(pool, {phone, templateId, data, orderRef, oaRef, sentBy, customerId})`

1. Chuẩn hoá SĐT về `84xxxxxxxxx`.
2. **Idempotency theo `orderRef`**: SELECT `web2_zns_log` cùng `phone+templateId+orderRef`, status `sent|pending`, trong 10 phút → có → trả `duplicate:true`, KHÔNG gọi Zalo (chống tốn phí khi retry/double-click).
3. Log `pending` TRƯỚC khi gọi API (audit trail dù fail giữa chừng).
4. POST ZNS_TEMPLATE_URL `{phone:phone84, template_id, template_data:data, tracking_id: orderRef||logId}`.
5. Update log: `status='sent'|'failed'`, `zalo_msg_id`, `quota_cost` (từ `data.quota.remainingQuota`), `error_msg`.
6. Lỗi → update log `failed` (chỉ nếu còn `pending`) rồi re-throw.

### 6.3 `sendCsMessage(pool, {oaRef, userId, text})`

POST CS_MESSAGE_URL `{recipient:{user_id}, message:{text}}` — tin tư vấn cho user đã từng chat OA (không phí ZNS).

### 6.4 `syncTemplates(pool, oaRef)`

GET TEMPLATE_LIST_URL `?offset=0&limit=100&status=1` → UPSERT `web2_zns_templates` (`ON CONFLICT (template_id) DO UPDATE`).

---

## 7. Realtime SSE

Hub SSE Web 2.0 (topic-based pub/sub). Wiring: server gọi `zaloRoutes.initializeNotifiers(sseHub.notifyClients)`. Client subscribe qua bridge singleton (1 kết nối SSE/tab).

| Topic pattern | Payload | Publisher | Khi nào |
|---|---|---|---|
| `web2:zalo:<owner>:messages` | `{action:'create'\|'update', code: msgId, ts}` | `persistIncoming`, `persistOut`, `repairConvNames` | tin mới (in/out), sửa tên hội thoại |
| `web2:zalo:<owner>:thread:<threadId>` | `{action:'message'\|'typing'\|'reaction'\|'recall'\|'seen'\|'delete', code, ts}` | mọi persist cấp thread + `onTyping` | sự kiện cấp thread cụ thể |
| `web2:zalo:<owner>:accounts` | `{action:'create'\|'update'\|'deleted', code: accountKey, ts}` | `updateAccStatus`, `saveSession`, các route account | đổi trạng thái/tạo/xoá account |
| `web2:zalo:qr:<key>` | `{event:'qr'\|'expired'\|'scanned'\|'declined'\|'success'\|'error', ...}` (eventType SSE luôn `'update'`) | `POST /login-qr` | luồng quét QR |
| `web2:zalo:messages` (bare) | `{action:'pin'\|'mute'\|'mark', code: convId, ts}` | route pin/mute/mark | ⚠ inconsistency: bare, không owner-scoped |
| `web2:zalo:accounts` (bare) | `{action:'create'\|'tracked-changed'\|'reset', code, ts}` | oa/connect, tracked-groups, admin reset | |

> `owner` luôn = `'__global__'` → mọi topic thực tế là `web2:zalo:__global__:*`. **⚠ Gotcha**: owner NULL → topic thành `_none` = KHÔNG máy nào nghe. Luôn dùng hằng số nhất quán cả client lẫn server.

**Hai tầng realtime ở client** (tránh double-refetch):
- Tầng DANH SÁCH: subscribe `:accounts` (debounce 500ms → reload accounts) + `:messages` (debounce 600ms → reload danh sách hội thoại, CHỈ khi đang ở tab chat).
- Tầng TIN của hội thoại đang mở: engine chat subscribe riêng `:thread:<threadId>` (debounce 450ms → refetch tin của thread đó). KHÔNG động vào tầng danh sách.

---

## 8. Chrome Extension (đọc credential)

Content script chạy trên origin `chat.zalo.me`:
- **`readImei()`** — `localStorage['z_uuid']` (fallback `'sh_z_uuid'`) = device uuid.
- **`readUid()`** — ưu tiên `localStorage['sh_zlast_uid']` → `'sh_z_recentuid'` → phần tử đầu mảng JSON `localStorage['sh_user_ids']`.
- **`snapshot()`** → `{imei, userAgent: navigator.userAgent, uid}`.
- **2 cơ chế truyền ra background**:
  1. Auto-cache lúc load: `cacheNow()` + retry mỗi 1.5s tối đa 6 lần (chờ `z_uuid` set trễ) → `chrome.runtime.sendMessage({type:'ZALO_CREDS_CACHE', imei, userAgent, uid})`. Chưa có imei (chưa login) → bỏ qua.
  2. On-demand: nghe `{type:'ZALO_READ_CREDS'}` → `sendResponse(snapshot())`.
- **Cookie KHÔNG đọc bởi content script** (localStorage origin-bound) → **background script** đọc qua `chrome.cookies` API (đọc được cả httpOnly).
- Payload cuối cùng gửi server: `{cookie (từ background), imei, userAgent (từ content)}` → `POST /accounts/:key/login-cookie`.

---

## 9. Frontend — trang quản trị Zalo

Trang gốc `web2/zalo/` là nơi login/quản lý account/OA/ZNS + chat. Bố cục **icon-rail 3-pane kiểu Zalo PC**:

```
.wz-app (flex row)
 ├ nav.wz-rail (icon rail dọc, role=tablist) — 4 tab + đèn health
 └ .wz-view — 4 <section role=tabpanel>
```

**4 tab** (roving tabindex ARIA APG: ←/→/Home/End di chuyển focus, Enter/Space kích hoạt, KHÔNG fetch khi chỉ di focus):

1. **Chat** (mặc định) — 3 cột: `.wz-conv-col` (select account + danh sách hội thoại có search+sync) | `.wz-chat-main` (mount engine chat) | `.wz-info-panel` (avatar/tên/loại/SĐT/UID, hidden mặc định).
2. **Tài khoản** (chỉ admin) — grid card account.
3. **Tra cứu** — form SĐT → lookup uid/tên/avatar; nút "Thông tin của tôi".
4. **ZNS** — form gửi (SĐT + select template + form động theo params + JSON thủ công) + bảng log.

**2 modal**: `#wzLoginModal` (2 lựa chọn: cookie 1-click / QR — QR hiển thị ảnh base64, subscribe SSE `web2:zalo:qr:<key>`) và `#wzOaModal` (App ID/Secret/Code/OA ID/Tên).

### Module JS (namespace cộng dồn `WZApp`, load theo thứ tự phụ thuộc)

- **utils** — `TZ='Asia/Ho_Chi_Minh'`, `$`, `esc` (escape `&<>"'`), `notify`, `avatarHtml` (img + fallback span chữ cái đầu, `referrerpolicy="no-referrer"` cho CDN Zalo), `showModal/hideModal` (focus-trap a11y), `fmtTime` (Intl GMT+7), `STATUS_LABEL`, và **`state`** (object trung tâm KHÔNG persist: `{tab, zcaAvailable, accounts[], conv:{list,total,activeId,activeConv,messages,accountKey,search}, zns:{templates,log}}`).
- **accounts** — `loadAccounts` (`ZaloApi.status`), render card theo trạng thái, login flow: `openLogin` → auto thử cookie qua extension (`Web2Ext.request('GET_ZALO_CREDS')`) → `doCookieLogin`/`startQrLogin` (subscribe SSE QR + `ZaloApi.loginQr`), `onQrEvent` (vẽ ảnh QR/scanned/expired/success), OA modal.
- **chat** — `loadConversations` (`ZaloApi.conversations`, snapshot unread trước để diff → notify tin mới, anti-giật render guard), `openConversation` (destroy view cũ → `WZChat.mountConversation` → render info panel), context menu pin/mute/mark (optimistic-first + rollback).
- **lookup-zns** — `doLookup`, `showSelf`, `loadTemplates`, `renderZnsFields` (form động 1 input/param), `sendZns`, `loadZnsLog`.
- **notify** — diff danh sách trước/sau mỗi reload: tin mới = inbound + unread tăng + không phải hội thoại đang mở → toast + beep (Web Audio 880Hz throttle 1500ms) + badge title + browser Notification (chỉ khi tab ẩn). Sound toggle `localStorage['wz_notify_sound']`.
- **app** (orchestrator) — `switchTab` (lazy-load theo tab, gate accounts chỉ admin), `bind` (wire mọi event), `subscribeSse` (2 tầng như §7), `init` (đọc `?focus=<phone>` từ URL → mở sẵn hội thoại).

---

## 10. Frontend — bộ UI kit chat (WZChat)

10 module JS + 3 CSS, attach vào **1 namespace `window.WZChat`** (viết tắt `WZ`). Script-tag classic IIFE, **lazy-load động** (không load sẵn ở mọi trang). Thứ tự bắt buộc: `chat-store` đầu (định nghĩa `esc/avatarHtml/store`), `chat-view` cuối (dùng mọi hàm khác).

Entry point duy nhất: **`WZChat.mountConversation(container, conv, opts) → {conv, reload, refresh, destroy}`** — dựng toàn bộ khung 1 hội thoại (header + search + body tin + composer) vào container bất kỳ.

- `conv`: `{id, account_key, thread_id, thread_type:'user'|'group', display_name, avatar_url}`.
- `opts`: `{getForwardTargets?, onError?, autoSeen?}`.

### Data shape message (chuẩn render xuyên suốt)

```js
{
  msg_id, cli_msg_id, direction: 'in'|'out',
  msg_type,                 // text|image|sticker|video|voice|file|link|location|contact|system|recalled
  content,
  attachments: [{type, url, thumb, href, title, phone, lat, lon, ...}],
  reply_to_preview, reply_to_msg_id,
  reactions: {emoji: [uid,...]},
  recalled, send_status: 'sending'|'sent'|'failed',
  seen_at, sent_at, sender_uid, sender_name, sender_avatar
}
```

### Từng module

- **chat-store** — namespace gốc + state singleton phiên chat (`get/setConversation/setMessages/setReplyTarget/addPending/markRecalled/markSeen/patchReaction`), helpers `esc/initial/fmtTime/dayKey/dayLabel/avatarHtml`, `REACTIONS` (6 cảm xúc), `openMenu/closeMenu` dropdown chung.
- **chat-view** — điều phối chính: `mountConversation`, `shell` (dựng DOM), `renderBody` (giữ/khôi phục scroll), **`optimistic(m)`** (push tin out ngay, sinh `cli_msg_id` bằng `crypto.randomUUID()` — TOÀN CỤC duy nhất), `reconcile` (patch sau khi server trả msgId thật), 5 hàm gửi (text/media/file/voice/sticker), `buildReplyQuote` (dựng object quote thô cho zca — bắt buộc để reply thật), `loadOlder` (2 tầng: DB keyset → backfill nhóm 1 lần), `reload`/`refresh`, tìm trong hội thoại (nạp hết lịch sử, bỏ dấu tiếng Việt, tô `<mark>`, điều hướng), subscribe realtime.
- **composer** — `mountComposer(root, ctx) → {setReply, reset, focus, refresh}`. File→base64 (giới hạn 25MB), tray đính kèm, reply bar, textarea auto-grow, **busy-lock chống double-Enter**, quick replies (gõ `/`), ghi âm voice (MediaRecorder), **@mention nhóm** (gõ `@` → load member → dropdown → `mentions:[{uid,pos,len}]`), drag-drop + paste ảnh.
- **bubbles** — renderer thuần: `renderMessages` (gom nhóm theo sender liên tiếp, date-divider GMT+7, unread-divider, tin system giữa khung, avatar chỉ ở tin cuối lượt), `body` theo kind (grid ảnh album, sticker, video/voice player inline, file link, contact/location/link-preview card), reaction row, reply row, status tick (🕓/⚠/✓/✓✓), hover toolbar (reply/react/recall/delete).
- **chat-actions** — network layer gọi `ZaloApi.*`: `react/recall/deleteForMe/forward/markSeen/emitTyping`. `markSeen`/`emitTyping` throttle (3s/2s), fire-and-forget.
- **reactions** — popup 6 nút cảm xúc nổi (`z-index:100000` để nổi trên mọi drawer).
- **realtime** — `subscribeRealtime(convId, threadId, handlers) → unsub`. Subscribe 1 topic `web2:zalo:<owner>:thread:<threadId>`, mọi action → debounce 450ms → `handlers.refetch()`; `typing` → `onTyping(true)` tự tắt sau 4s.
- **lightbox** — overlay xem ảnh full-screen, gom mọi ảnh trong thread cho prev/next.
- **emoji-picker** / **sticker-picker** — recents lưu localStorage; sticker gọi `ZaloApi.stickers` có cache.

### CSS

- **chat-bubbles.css** — `.wz-msg` (`.in`/`.out`/`.grouped`), bubble in nền trắng / out gradient xanh, `.wz-msg-reply`/`-reactions`/`-meta`/`-grid`, card preview, typing 3 chấm, date/unread divider, khối tìm kiếm. **Định nghĩa toàn bộ biến `--wz-*` scoped `.wz-chat-main`** để self-contained khi nhúng ngoài.
- **chat-composer.css** — composer ghim đáy, voicebar, tray, drop overlay, popover chung (emoji/sticker/menu), react bar, mention dropdown.
- **chat-lightbox.css** — overlay `position:fixed;inset:0;z-index:2000`, nút điều khiển fixed.

---

## 11. Lớp cổng chung & nhúng vào trang khác

### 11.1 `ZaloApi` (wrapper HTTP) — `window.ZaloApi`

Wrapper toàn bộ `/api/web2-zalo/*`. **Dual-base fallback**: thử base chính (qua proxy/worker alias) trước, lỗi mạng/5xx → fallback base trực tiếp; 4xx/`{success:false}` → throw ngay. `authHeaders()` luôn gửi `x-web2-zalo-owner:'__global__'` + token auth. Đây là module mà `WZChat` gọi trực tiếp (`WZChat` không tự fetch).

### 11.2 `Web2Zalo` (cổng công khai) — `window.Web2Zalo`

Cổng DUY NHẤT để trang khác dùng Zalo. API:
- `sendZNS({phone, templateId, data, orderRef, customerId})`
- `sendMessage({accountKey, threadId, text, threadType, cliMsgId})` (tự sinh `cliMsgId` nếu thiếu)
- `getConversation(phone, accountKey?)`, `status()`
- `openChat(phoneOrId)` — mở tab mới trang Zalo `?focus=<phone>`
- `attachZaloButtons(root)` — quét `[data-w2zalo-phone]` gắn nút pill "Zalo"
- `normPhone(p)` — chuẩn hoá SĐT
- **`loadChatEngine()`** — lazy-load động toàn bộ engine chat (append script/link vào head, cache promise)
- **`mountChat(container, opts)`** — nhúng 1 hội thoại vào trang bất kỳ. Resolve `conv` theo thứ tự: `opts.conv` → `opts.phone` (`getConversation`, chưa có → `POST /conversation/ensure`) → `opts.convId` (cho nhóm). `preferAccountKey` — ưu tiên TK đang đăng nhập cookie trình duyệt. Cuối cùng gọi `WZChat.mountConversation`.
- `getCookieAccountKey(opts)` — resolve accountKey khớp TK đang login `chat.zalo.me` (đọc creds qua extension, cache 30s, tự tạo/login slot nếu cần).

### 11.3 `Web2CustomerChat` — drawer/modal 2 tab Pancake + Zalo

`Web2CustomerChat.open(opts)` — được MỌI trang nghiệp vụ dùng để mở chat KH. 2 tab **Pancake | Zalo**, lazy-mount theo tab:
- `pancakeEnabled`/`zaloEnabled` bật/tắt từng kênh; `channel` mặc định + ép về kênh còn lại nếu kênh kia tắt.
- `opts.conversationId` — mở Zalo theo convId trực tiếp (cho nhóm, không cần SĐT).
- `mountZalo()`: nếu chat 1-1 (`phone && !convId`) → lấy `preferKey` từ `getCookieAccountKey` trước → `Web2Zalo.mountChat(host, {phone, convId, autoSeen, preferAccountKey})`; callback `onReady(zaloHandle, host)`.
- **Zalo tự lo realtime riêng** (qua `WZ.subscribeRealtime` bên trong `mountConversation`) — tab này không refetch Zalo, chỉ Pancake.
- `close()` gọi `zaloHandle.destroy()` (unsubscribe SSE + xoá DOM).

Load order bắt buộc: `web2-zalo.js → customer-chat-core → customer-chat-modal → customer-chat.js`.

### 11.4 Tích hợp sâu: tra vận đơn từ NHÓM Zalo

Một trang nghiệp vụ dùng nhóm Zalo làm nguồn dữ liệu (không chỉ chat):
- `POST /scan` — server đọc tin nhóm gần đây, trích mã (regex), trả `{found, added}`.
- `POST /scan-history {days, count}` — đọc sâu lịch sử nhóm (giới hạn zca, trả cờ `more`).
- Mở chat Zalo-only: `Web2CustomerChat.open({conversationId, channel:'zalo', pancakeEnabled:false, onReady})`, callback tự cuộn + highlight tin chứa mã (polling DOM, tự bấm "tải tin cũ" tối đa N lần).
- Công cụ bù thủ công (`POST /scan-text {text, convId}`): user chạy script Console trên `chat.zalo.me` tự cuộn lấy lịch sử cũ, copy dán vào — vá cho việc zca không lấy được lịch sử quá sâu.

---

## 12. Luồng end-to-end

### (a) Thêm account + login
1. Admin `POST /accounts {label}` → shell personal, `status='disconnected'`.
2. **Cookie 1-click**: user đã login `chat.zalo.me` trên Chrome có extension → extension đọc `{cookie, imei, userAgent, uid}` → `POST /accounts/:key/login-cookie`.
3. Route → `zca.loginWithCredentials(key, {cookie,imei,userAgent,language:'vi'}, label, {expectedUid})`.
4. `afterLogin`: context + `fetchAccountInfo` → guard `expectedUid` → `persistSession` (mã hoá + ghi DB) → attach listener → watchdog.
5. SSE `accounts` → UI reload, hiện connected.
6. **QR**: `POST /login-qr` (fire-and-forget) → SSE `web2:zalo:qr:<key>` đẩy ảnh QR → user quét app mobile → success → cùng `afterLogin`.
7. Reboot: `restoreSessions()` decrypt `session` login lại mọi account (không cần QR lại trừ cookie hết hạn).

### (b) Nhận tin đến → lưu → realtime UI
1. WebSocket listener nhận `message` → `normMessage`.
2. Callback `onMessage` → `persistIncoming`.
3. (Nếu allowlist bật và nhóm không tracked → bỏ qua; mặc định tắt → lưu tất.)
4. INSERT message (dedup msg_id) → UPSERT conversation (cộng unread CHỈ khi tin mới + có msg_id + direction='in'; cập nhật tên/uid CHỈ khi tin đến 1-1).
5. Tin mới → SSE `:messages` (create) + `:thread:<id>` (message) → client re-fetch.
6. Nếu nhóm → fire-and-forget quét mã vận đơn.
7. Client mở conversation → `GET /conversations/:id/messages` → lazy-heal tên/avatar (TTL 6h), resolve sender nhóm, reset unread nếu mở mới.

### (c) Gửi tin đi
1. Client `POST /send-message` (hoặc image/file/sticker) với `cliMsgId`.
2. `withSendGuard` dedupe → double-click trả kết quả cũ.
3. `zca.send`/`sendMedia`/`sendSticker` (thao tác thật). Ảnh/file: base64 → bytea `web2_zalo_media` (token) → URL proxy → upload Zalo CDN.
4. `persistOut` INSERT out + UPDATE conversation → SSE `:messages`/`:thread`.
5. Trả `{msgId, cliMsgId, id, sentAt}`.

### (d) Lookup SĐT → uid
`GET /lookup?accountKey&phone` → `zca.findUser` (cần account connected). `POST /conversation/ensure` dùng cơ chế này tạo hội thoại 1-1 mới. SĐT strip non-digit; ZNS convert `84xxx`.

### (e) Gửi ZNS/OA
1. Admin `POST /oa/connect` (OAuth authorization_code, cần appId+secret+code từ Zalo Developers).
2. `syncTemplates` → `web2_zns_templates`.
3. `POST /send-zns {phone, templateId, data, orderRef?}` → rate-limit (5/SĐT/60s) → service idempotency `orderRef` (10 phút) → refresh token nếu cần (dedup Promise) → Zalo Business API → log `web2_zns_log`.
4. Tin tư vấn (không phí ZNS, chỉ user đã chat OA): `POST /oa/send-cs`.

---

## 13. Bẫy & bài học

1. **Owner-scoped ĐÃ CHẾT nhưng plumbing còn nguyên** — mọi `owner`/`ownsAccount`/`ownerTopic`/header/lease bị ép hằng số `'__global__'`. Hiện thực lại: bỏ hẳn nếu không cần multi-tenant per-máy.
2. **zca-js KHÔNG chính thức, rủi ro BAN** — dùng account phụ, tránh spam. Không có refresh token → tự "proactive re-login" trong cửa sổ ~7 ngày.
3. **Bị KICK (close 3000/3003)** = tài khoản đang mở ở nơi khác (Zalo Web máy khác). Không mất cookie, chỉ rớt listener → cần trần số lần liên tiếp (`KICK_CAP`) tránh "đấu" vô hạn.
4. **Always-on global** → tài khoản Zalo của tool **sẽ bị đá khỏi `chat.zalo.me`** nếu ai đó mở app đó cùng lúc. Chấp nhận trade-off → dùng account riêng cho tool.
5. **`getGroupChatHistory` KHÔNG có cursor phân trang** — chỉ 1 batch gần nhất/lần gọi, `more>0` chỉ là cờ, không lấy tiếp được (trần cứng).
6. **Không có API "tất cả hội thoại"** — chỉ seed từ bạn+nhóm (`getRoster`); KH lạ chỉ vào qua realtime.
7. **Tên hội thoại 1-1 dễ bị "nhiễm"**: shop nhắn trước tạo conversation với `senderUid` là của SHOP → CỐ Ý không dùng để set tên/uid hội thoại (chỉ set khi `direction='in'` cho 1-1); có lazy-heal + force-repair (luôn resolve theo `thread_id` = uid KHÁCH, không dùng cột `zalo_uid` có thể bẩn).
8. **Reaction icon mapping 2 chiều** — giá trị nhận vào (`/-heart`) ≠ enum gửi ra (`HEART`); cả hai convert về emoji Unicode để lưu thống nhất.
9. **Reaction lưu ATOMIC** — 1 UPDATE `jsonb_set` + `array_agg DISTINCT` dưới row lock (tránh mất khi 2 event gần nhau).
10. **`encryptJson` chống double-wrap** — bug lịch sử: mã hoá 2 lần → lồng ciphertext → decrypt ra string thay vì object → restore fail. Fix: nhận diện value đã có marker mã hoá thì trả nguyên. **Giữ bất biến này khi port.**
11. **`persistIncoming` chỉ cộng unread khi có `msg_id`** — vì unique dedup là partial index; tin thiếu msg_id luôn INSERT lại → gate `isNew && direction='in' && msg.msgId`.
12. **Media URL nhúng VĨNH VIỄN vào JSON `attachments`** — build URL qua domain ổn định (proxy), đổi raw host sẽ vỡ link ảnh cũ.
13. **`send_jobs`/`send_items`** có schema, CHƯA có route xử lý — implement bulk phải viết mới.
14. **`/admin/reset-to-tracked`** xoá TOÀN BỘ 4 bảng chat (không WHERE) — cần secret + confirm `'YES-RESET'`.
15. **`cli_msg_id` phải toàn cục duy nhất** (`crypto.randomUUID()`) — bộ đếm per-view reset khi remount → trùng key trong TTL dedupe 60s → tin thứ 2 bị nuốt.
16. **Double-Enter mint 2 cliMsgId khác nhau** → server dedup không nhận ra → gửi trùng thật. Composer phải busy-lock.
17. **Reply phải dựng object quote thô đầy đủ** (`{content, msgType, propertyExt, uidFrom, msgId, cliMsgId, ts, ttl}`) — chỉ gửi `{msgId, preview}` → backend nhận `quote=null` → tin không phải reply thật.
18. **Timezone GMT+7** ở tầng hiển thị (Intl `Asia/Ho_Chi_Minh`); lưu DB luôn epoch ms UTC.
19. **Escape HTML mọi chỗ nội suy user-input** vào innerHTML (tên, SĐT, preview) — chống XSS.
20. **Avatar CDN Zalo chặn hotlink** — cần `referrerpolicy="no-referrer"`; ảnh lỗi fallback span chữ cái đầu.
21. **BIGINT id qua JSON có thể là string** — so sánh `String(a) === String(b)`.
22. **Graceful shutdown `stopAll()`** lúc deploy — nếu không, 2 instance "đấu" phiên → kick 3000/3003 liên tục.

---

## 14. Checklist hiện thực lại

**Backend**
- [ ] Cài `zca-js` (hoặc lib tương đương), require phòng thủ.
- [ ] Tạo schema `web2_zalo_*` + `web2_zns_*` (idempotent, epoch ms BIGINT, partial unique index dedup msg_id).
- [ ] Lớp mã hoá at-rest cho session/token (chống double-wrap).
- [ ] Service zca: login (cookie + QR), listener 7 event, chuẩn hoá message, watchdog (keepalive + proactive re-login + backoff + kick handling), persist + boot-restore, graceful shutdown.
- [ ] Service OA/ZNS: OAuth token (dedup refresh Promise), sendZNS (idempotency orderRef + rate-limit), syncTemplates, sendCs.
- [ ] ~30 REST endpoint (`withSendGuard` dedup, `safeAccount` strip secret, lazy-heal tên/avatar, keyset pagination, serve media token-based).
- [ ] SSE hub: topic `messages`/`thread:<id>`/`accounts`/`qr:<key>`, wiring notifier.
- [ ] Cron: retention (xoá tin/media > N ngày), watchdog 90s.

**Extension** (nếu dùng cookie 1-click)
- [ ] Content script đọc `z_uuid`/uid + userAgent; background đọc cookie (`chrome.cookies`).
- [ ] Truyền creds cho frontend → `POST /login-cookie`.

**Frontend**
- [ ] Wrapper HTTP (`ZaloApi`) + cổng công khai (`Web2Zalo`) + engine chat (`WZChat`, lazy-load).
- [ ] Trang quản trị: 4 tab (chat 3-cột / accounts / lookup / ZNS), 2 modal (login cookie+QR / OA).
- [ ] Engine chat: `mountConversation`, optimistic + reconcile, composer (media/voice/@mention/quick reply/reply quote thô), bubbles đủ loại, realtime thread-scoped, lightbox, emoji/sticker picker.
- [ ] Launcher đa kênh (`Web2CustomerChat`) nếu cần nhúng vào trang nghiệp vụ.
- [ ] Notify (diff unread, beep, badge, browser Notification), timezone GMT+7, escape HTML, avatar fallback.

**ENV cần cấu hình** (chỉ tên): khoá mã hoá at-rest, cờ enforce auth, cờ allowlist nhóm, secret cleanup, base URL media, cờ tắt jobs (cho instance phụ).
