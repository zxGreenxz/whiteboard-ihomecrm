# Chat Zalo — Worker zca-js (hợp đồng + hướng dẫn chạy)

> Trang Chat Zalo trong CRM này **chỉ nói chuyện với Supabase** (bảng + Realtime +
> RPC). Phần web (React trên Vercel) **không bao giờ gọi Zalo trực tiếp**. Kết nối
> Zalo thật do **một worker zca-js** (tài khoản Zalo **cá nhân**) đảm nhiệm:
> đọc hàng đợi gửi rồi gửi bằng zca-js, và nghe tin đến rồi ghi vào DB. Supabase
> Realtime tự đẩy thay đổi sang trình duyệt.
>
> **Chạy LOCAL trước** (trên máy bạn, để dev/test live) → **lên VPS sau** (Vultr…)
> để giữ phiên 24/7. **KHÔNG cần VPS cho phần web.** OA/ZNS để sau.
>
> ⚠️ Worker **chạy riêng**, KHÔNG nằm trong repo web (không deploy lên Vercel).
> `docs/zalo/*` khác chỉ là tham khảo ý tưởng từ n2store — **không** dùng lại backend đó.

---

## 0. ĐỔI LỚN 2026-08-13 — đọc trước khi khởi động lại worker

Worker đã tách module (`worker/lib/*`) và thêm 4 hàng rào. **Ba việc bắt buộc
khi nâng cấp từ bản cũ:**

1. **`ZALO_SESSION_KEY` là BẮT BUỘC** trong `worker/.env` — phiên Zalo giờ mã
   hoá at-rest AES-256-GCM, worker **từ chối chạy** nếu thiếu key (64 hex):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   File phiên plaintext cũ trong `worker/sessions/` được **tự mã hoá tại chỗ**
   lần chạy đầu. ⚠️ Mất/đổi key = mọi phiên đã lưu vô dụng → quét QR lại.
   Backup key ở chỗ an toàn NGOÀI repo.
2. **Lease đơn-instance** (bảng `zalo_worker_lease`): tại một thời điểm chỉ MỘT
   worker chạy; instance mới chờ instance cũ nhả (≤35s), instance cũ thấy lease
   đổi chủ thì tự thoát. Hết cảnh 2 máy "đấu" phiên đá nhau (close 3000/3003).
   pm2 nên đặt `kill_timeout: 15000` để graceful shutdown kịp nhả lease.
3. **Đa công ty (org-scoped)**: worker stamp `organization_id` vào mọi dòng nó
   ghi (lấy từ `zalo_accounts.organization_id`). Một worker phục vụ được nhiều
   công ty; muốn tách hẳn worker theo công ty → đặt
   `WORKER_ORG_IDS="uuid1,uuid2"` trong `.env`.

Kèm theo (không cần cấu hình): watchdog keepAlive 90s, proactive re-login 3.5
ngày trước hạn cookie ~7 ngày, backoff khi rớt mạng, nghỉ 10 phút khi bị đá
phiên 4 lần liên tiếp, guard WRONG_ACCOUNT (uid lạ không được gắn vào slot),
job mới: gửi ảnh/file/voice/sticker (tải bytes từ bucket `zalo-media`),
find_user (soạn tin theo SĐT), sticker_list, delete_for_me, seen/typing.

---

## 1. Kiến trúc

```
┌──────────────┐   RPC zalo_send_message    ┌────────────────────┐
│  Web (React) │ ─────────────────────────► │ Supabase (Postgres)│
│  trên Vercel │ ◄───── Realtime ────────── │  bảng zalo_*       │
└──────────────┘                            └─────────┬──────────┘
                                                       │ service_role
                                  poll queue / ghi inbound │
                                              ┌────────────▼───────────┐
                                              │  Worker zca-js (Node)  │
                                              │  local trước → VPS sau │
                                              │  giữ phiên Zalo cá nhân│
                                              └────────────────────────┘
```

- **Outbound**: user gửi tin → RPC `zalo_send_message` chèn `zalo_messages`
  (`status='pending'`) + 1 dòng `zalo_send_queue` (`status='queued'`). Worker đọc
  queue, gửi bằng zca-js, cập nhật trạng thái.
- **Inbound**: worker nghe sự kiện zca-js → chèn `zalo_messages` (`direction='in'`)
  + cập nhật `zalo_conversations`. Realtime đẩy sang trình duyệt (đã kiểm chứng).

---

## 2. Hợp đồng bảng (worker đọc/ghi những cột này)

### `zalo_send_queue` (đọc — hàng đợi gửi)
| cột | ý nghĩa |
|---|---|
| `id` | khoá |
| `user_id` | chủ (owner) |
| `conversation_id` | hội thoại |
| `message_id` | dòng `zalo_messages` tương ứng (đặt `status` ở đây) |
| `account_id` | tài khoản Zalo dùng để gửi |
| `channel` | `'personal'` (zca-js) — vòng này chỉ dùng giá trị này; `'oa'` để sau |
| `payload` | `{type, body, media_url, reply_to}` |
| `status` | `queued` → worker đặt `processing` → `sent`/`failed` |
| `attempts`, `last_error`, `processed_at` | retry/log |

### `zalo_messages` (ghi inbound / cập nhật tick outbound)
`user_id, conversation_id, account_id, direction('in'|'out'), msg_type('text'|'image'|'file'|'sticker'|'sys'),
body, media_url, media_label, media_tone, reply_to(jsonb {name,text}), reactions(jsonb),
reaction_emoji, status('pending'|'sent'|'delivered'|'seen'|'failed'), zalo_msg_id, cli_msg_id, sent_at, created_at`.

### `zalo_conversations` (cập nhật khi có tin)
`last_message_text, last_message_at, last_message_dir, unread_count` (inbound: +1),
`peer_name, peer_avatar_url, peer_zalo_uid, profile(jsonb snapshot panel), is_online`.
Map `account_id + thread_id` là khoá duy nhất để tìm/khởi tạo hội thoại.

### `zalo_accounts` (cập nhật trạng thái phiên)
`status('connected'|'disconnected'|'error')`, `zalo_uid`, `meta` (lưu cookie/imei mã hoá nếu cần).

---

## 3. Vòng lặp worker (pseudo-code)

```js
import { createClient } from '@supabase/supabase-js';
import { Zalo } from 'zca-js';                       // npm i zca-js
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// 1) Đăng nhập (lần đầu QR; sau đó re-login từ cookie đã lưu)
const zalo = new Zalo();
const api = await zalo.loginQR();                    // hoặc zalo.login({cookie, imei, userAgent})
saveCookie(api.getContext());                        // lưu để re-login (file/Secret)
await sb.from('zalo_accounts').update({ status: 'connected' }).eq('id', ACCOUNT_ID);

// 2) OUTBOUND: poll queue mỗi ~1.5s
setInterval(async () => {
  const { data: jobs } = await sb.from('zalo_send_queue')
    .select('*').eq('status', 'queued').eq('channel', 'personal').order('created_at').limit(5);
  for (const j of jobs ?? []) {
    await sb.from('zalo_send_queue').update({ status: 'processing' }).eq('id', j.id);
    try {
      const conv = await getConv(j.conversation_id);
      const res = await api.sendMessage(           // ảnh: api.uploadAttachment → sendMessage
        { msg: j.payload.body, quote: j.payload.reply_to ?? undefined }, conv.thread_id, conv.thread_type);
      await sb.from('zalo_messages').update({ status: 'sent', zalo_msg_id: res.msgId, cli_msg_id: res.cliMsgId })
        .eq('id', j.message_id);
      await sb.from('zalo_send_queue').update({ status: 'sent', processed_at: new Date().toISOString() }).eq('id', j.id);
    } catch (e) {
      await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', j.message_id);
      await sb.from('zalo_send_queue').update({ status: 'failed', last_error: String(e), attempts: j.attempts + 1 }).eq('id', j.id);
    }
  }
}, 1500);

// 3) INBOUND: nghe sự kiện zca-js → ghi vào DB (Realtime tự đẩy lên web)
api.listener.on('message', async (m) => {
  const conv = await upsertConversation(m);          // map account_id + thread_id
  await sb.from('zalo_messages').insert({
    user_id: conv.user_id, conversation_id: conv.id, account_id: ACCOUNT_ID,
    direction: m.isSelf ? 'out' : 'in', msg_type: typeOf(m), body: m.text ?? null,
    zalo_msg_id: m.msgId, cli_msg_id: m.cliMsgId, status: 'delivered', created_at: new Date().toISOString(),
  });
  await sb.from('zalo_conversations').update({
    last_message_text: m.text ?? '[Hình ảnh]', last_message_at: new Date().toISOString(),
    last_message_dir: m.isSelf ? 'out' : 'in',
    unread_count: m.isSelf ? conv.unread_count : conv.unread_count + 1,
  }).eq('id', conv.id);
});
api.listener.start();

// 4) Watchdog: bị "văng nick" (close 3000/3003) ≠ mất đăng nhập → re-login từ cookie.
//    Graceful SIGTERM, pin imei/userAgent, KHÔNG mở Zalo Web nơi khác cùng nick (single-listener).
```

> Bị kick (mở Zalo Web ở máy khác) chỉ làm **rớt listener nhận tin**, KHÔNG mất
> đăng nhập — cookie vẫn hợp lệ, gửi được & re-login được. Vì vậy worker cần
> watchdog tự reconnect từ cookie và tài khoản phụ **dùng riêng** cho worker.

---

## 4. Chạy LOCAL trước (dev/test)

1. Tạo thư mục riêng (ngoài repo web), `npm init -y && npm i zca-js @supabase/supabase-js`.
2. Tạo `.env`:
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key — Project Settings ▸ API>
   ZALO_ACCOUNT_ID=<id dòng zalo_accounts của bạn>
   ```
   > Service-role key **bí mật tuyệt đối** (bypass RLS) — chỉ để trên máy/VPS của bạn,
   > KHÔNG đưa vào frontend/Vercel/repo.
3. `node worker.js` → quét QR bằng app Zalo trên điện thoại để đăng nhập lần đầu.
4. Lưu cookie/imei/userAgent (file `.zalo-session.json`) để lần sau re-login không cần QR.
5. Mở trang Chat Zalo trên web → gửi/nhận thử (worker chạy nền trên máy bạn).

## 5. Triển khai VPS sau (giữ phiên 24/7)

- VPS nhỏ là đủ (vd **Vultr** gói ~$5–6/tháng). Cài Node LTS, copy worker + `.env` + session file.
- Chạy nền bền: **pm2** (`pm2 start worker.js --name zalo-worker && pm2 save && pm2 startup`)
  hoặc **systemd** service (`Restart=always`).
- Mở 1 instance duy nhất / nick (single-listener). Khi deploy lại: dừng cũ trước (graceful SIGTERM).
- Theo dõi `zalo_accounts.status`; có thể thêm health-check log.

## 5b. Tự động hoá — bắt buộc làm trước khi BẬT (thêm 2026-08-30)

Worker giờ có hai engine: broadcast phòng trống định kỳ và auto-reply cho sale.
Broadcast **vẽ ảnh bảng ngay trên máy chạy worker**, nên máy đó phải đủ hai thứ:

```bash
cd worker
npm install            # kéo thêm @napi-rs/canvas (gói NATIVE, xem bẫy dưới)
npm run setup          # = tai-font.mjs + kiem-anh.mjs
```

**Rồi MỞ ẢNH `worker/kiem-anh-phong-trong.png` RA XEM BẰNG MẮT.** Chữ có dấu
(Trống, Phòng, Điện) phải đọc được. Đây không phải bước cho có: thiếu font tiếng
Việt **không** làm worker chết — nó vẫn vẽ, vẫn gửi, chỉ là mọi chữ có dấu ra ô
vuông. Không log nào đỏ, không job nào `failed`; người đầu tiên phát hiện ra sẽ là
khách hàng nhận ảnh. `npm run kiem-anh <organization_id>` vẽ bằng dữ liệu THẬT của
một công ty nếu muốn chắc hơn.

Ba bẫy nền tảng đã lường trước, script `kiem-anh` bắt được cả ba:

| Bẫy | Dấu hiệu | Chữa |
|---|---|---|
| **`@napi-rs/canvas` là gói native** | `import` nổ ngay lúc chạy `kiem-anh` | Chạy `npm install` **trên chính VPS**. Copy `node_modules` từ Windows sang Linux thì KHÔNG chạy. |
| **Thiếu font tiếng Việt** | Script in `Font: font-he-thong` kèm cảnh báo | `npm run tai-font`, hoặc cài font hệ thống: `apt-get install -y fonts-noto-core` |
| **Node thiếu full-ICU** | Script in `Định dạng giá: "4,500,000" ⚠ SAI` | Dùng bản Node chính thức (đã kèm full-ICU), đừng dùng bản small-icu tự build |

Sau khi ảnh xem được, vào web ▸ Chat Zalo ▸ tab **Tự động hoá** để cài lịch, người
nhận và các phanh chống spam. Cho tới khi có người bấm bật, engine **không gửi gì** —
`enabled = false` là mặc định.

Kiểm nhanh engine có sống không: bảng `zalo_automation_runs` phải có dòng mới sau
mỗi lượt (kể cả lượt "bỏ lượt"). Không có dòng nào = worker chưa chạy engine, hoặc
tài khoản Zalo đã rớt phiên (engine bỏ qua hội thoại của account không có phiên
sống — cố ý, để không tạo ra một đống job `failed`).

## 6. Chống Zalo nhận diện đa-nick "cùng máy"

**Làm rõ:** Zalo **KHÔNG đọc được MAC address / ID phần cứng / fingerprint trình
duyệt**. Worker nói chuyện như **Zalo Web** (HTTPS + WebSocket) — không có quyền
đọc MAC/serial, và worker **không phải trình duyệt** nên không có canvas/WebGL/font
fingerprint. Tín hiệu Zalo dùng để liên hệ "cùng máy" + cách worker cô lập:

| Tín hiệu | Cô lập |
|---|---|
| **imei** (UUID thiết bị) | Tự sinh `randomUUID + MD5(UA)` mỗi nick, lưu `sessions/<id>.json` → **đã riêng** ✓ |
| **user-agent** | Mỗi nick một UA thật cố định (`USER_AGENTS` + `uaFor(accountId)`); ghi đè được qua `zalo_accounts.meta.userAgent` ✓ |
| **cookie** | File phiên riêng từng nick ✓ |
| **IP** | **Cùng IP** nếu chạy chung 1 máy. Muốn tách → mỗi nick một **proxy** (xem dưới). |

**Proxy/IP riêng mỗi nick (nâng cấp tùy chọn — mạnh nhất):** `new Zalo({ polyfill })`
nhận custom fetch → bọc proxy cho HTTP (vd `undici` `ProxyAgent`). ⚠️ **WebSocket
nghe tin có thể vẫn lộ IP thật** nếu không tách egress (chạy mỗi nick một tiến
trình/VPS qua proxy/VPN riêng). Với 1–3 nick CSKH thường chưa cần.

**Quan trọng hơn cô lập thiết bị = hành vi:** Zalo khoá chủ yếu do **spam**, không
chỉ do "cùng máy". Hãy: giãn nhịp gửi, nội dung tự nhiên, dùng nick thật/đã dùng
lâu, **không** mở Zalo Web cùng nick nơi khác (bị kick listener). zca-js là API
**không chính thức** → vẫn có rủi ro khoá theo ToS; cô lập thiết bị chỉ **giảm**
khả năng bị gộp "cùng máy", không đảm bảo tuyệt đối.

## 7. OA / ZNS (để sau, chưa làm)

Khi cần kênh Official Account: schema đã chừa `zalo_message_templates.zns_template_id`
và `zalo_send_queue.channel='oa'`. Lúc đó bổ sung Edge Function `zalo-send` (gửi qua
OA API, serverless, không VPS) + webhook nhận tin — không đụng kiến trúc hiện tại.
