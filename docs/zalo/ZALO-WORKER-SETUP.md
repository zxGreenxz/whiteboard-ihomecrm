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

## 6. OA / ZNS (để sau, chưa làm)

Khi cần kênh Official Account: schema đã chừa `zalo_message_templates.zns_template_id`
và `zalo_send_queue.channel='oa'`. Lúc đó bổ sung Edge Function `zalo-send` (gửi qua
OA API, serverless, không VPS) + webhook nhận tin — không đụng kiến trúc hiện tại.
