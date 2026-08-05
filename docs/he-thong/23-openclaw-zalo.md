# OpenClaw Zalo cá nhân

> **Reviewed:** 2026-08-06. Route `/openclaw-zalo`. **CHƯA bật production** — `VITE_OPENCLAW_ZALO_MODE`
> mặc định `off`, và `demo` bị từ chối trong build production. Đây là thế hệ hai của kênh Zalo, **hoàn
> toàn tách biệt** với [Chat Zalo cũ](18-zalo-chat.md); việc tách đó được cưỡng chế bằng gate CI.

## 1. Vì sao có domain này, khác gì Chat Zalo cũ

| | Chat Zalo cũ ([18](18-zalo-chat.md)) | OpenClaw |
|---|---|---|
| Route / bảng | `/chat-zalo`, `zalo_*` | `/openclaw-zalo`, `openclaw_*` |
| Kết nối Zalo | một worker Node đơn (`worker/index.js`, pm2) | nhiều tiến trình có ranh giới tin cậy rõ ràng |
| Secret | service-role key + cookie phiên **plaintext** | phiên mã hoá AES-256-GCM, runtime token ngắn hạn, ticket ký số |
| Media | chỉ giữ URL CDN Zalo | R2 qua gateway có ticket, kiểm magic bytes + digest |
| Kiểm soát | không có policy engine / audit chain | policy quyết định từng lượt gửi, audit ký Ed25519, rollout theo bậc |

**Hai domain bị cấm chạm nhau.** `scripts/check-openclaw-isolation.mjs` (chạy trong CI) từ chối mọi tham
chiếu `chat-zalo`, `useZaloChat`, `zalo_*`, `worker/` bên trong vùng OpenClaw. Runbook rollback cũng ghi
rõ: không được đụng vào legacy. Nghĩa là **không tái sử dụng bất cứ thứ gì** của bản cũ — đó là quyết
định có chủ đích, không phải trùng lặp do lười.

## 2. Kiến trúc

```text
Trình duyệt ──► Edge openclaw-control        (mặt tiền cho NGƯỜI: 27 write + 17 read RPC)
            └─► Edge openclaw-object-tickets (xin ticket GET media, chỉ biết mediaId)

Bridge / Maintenance ──► Edge openclaw-runtime        (mặt tiền cho MÁY, không nhận origin trình duyệt)
                     └─► Edge openclaw-runtime-token  (đổi credential dài hạn → token ngắn hạn)

Watchdog (Cloudflare, NGOÀI VPS) ──► Edge openclaw-watchdog (envelope ký + nonce chống replay)
```

| Thành phần | Vai trò |
|---|---|
| **Bridge** (`services/openclaw-zalo-bridge`) | Ranh giới durability + policy giữa cell riêng tư và control plane. SQLite spool, heartbeat 10 s (stale 90 s), outbox send worker. Chỉ lộ `/livez`, `/readyz` không chứa nội dung |
| **Cell** (`services/openclaw-zalo-cell`) | Image bất biến chứa fork ZaloUser đã review. Build deny-by-default, `--network=none`, pin qua `image-lock.json`, có bằng chứng build tái lập được |
| **Session crypto** (`.../session-crypto`) | Daemon riêng mã hoá phiên Zalo trên đĩa; khoá chỉ nằm ở `/run/secrets/openclaw_session_key` |
| **Maintenance** (`services/openclaw-zalo-maintenance`) | Chỉ lo retention + audit theo tổ chức: `QUARANTINE`, `FINAL_DELETE`, `AUDIT_ANCHOR` (ký Ed25519). Không phụ thuộc tài khoản Zalo nào |
| **Egress broker** (`services/openclaw-egress-broker`) | **Đường ra mạng duy nhất.** Proxy `CONNECT` với allowlist FQDN đóng, DNS tra lại mỗi lần, chặn IP private/loopback/CGNAT/metadata, không cache quyết định |
| **Media gateway** (`infra/openclaw-media-gateway`) | Cloudflare Worker + R2. Object key bất biến, kiểm magic bytes + length + digest khớp ticket, từ chối active content, không lộ tên bucket |
| **Watchdog** (`infra/openclaw-zalo-watchdog`) | Chạy **ngoài** VPS. Chu kỳ 60 s; tự sinh control hãm khi quota cao: tạm dừng media nhóm ở ≥90 %, dừng toàn bộ outbound media ở ≥100 % |

## 3. Luồng nghiệp vụ

### Consent → QR → kết nối

1. **Disclosure**: chưa xác nhận, hoặc phiên bản disclosure đã đổi (`NEVER_ACKNOWLEDGED` /
   `VERSION_MOVED`) thì không được bắt đầu. Điều kiện phía client **mirror đúng** điều kiện SQL của
   `openclaw_begin_qr_login_v1` — hai bên lệch nhau là nguồn bug kinh điển.
2. **QR**: BEGIN (edge) → bridge publish **ciphertext** → POLL/CONSUME (edge giải mã) → finalize.
   TTL 120 giây là **trần hiển thị**; đếm ngược suy từ `issuedAt`/`expiresAt` thật của ticket.
3. Bị chặn vì: `PERMISSION`, `ALREADY_CONNECTED`, `UNRECOVERABLE_STATE`, `NO_READY_CELL`, `DISCLOSURE`.

### Trạng thái

- **Kết nối**: `DISCONNECTED → QR_PENDING → CONNECTING → CONNECTED → DISCONNECTING`, cộng
  `RECONNECT_REQUIRED`.
- **Rủi ro phiên**: `HEALTHY | DEGRADED | LIMITED | SUSPECTED_THEFT | INVALID`.
- **Chế độ** (phân biệt *configured* với *effective*): `DRAFT_ONLY | MANUAL_SEND | LIMITED_AUTO_REPLY |
  PROACTIVE | SALES_GROUPS`.
- **Outbox** — 7 trạng thái, transition khai báo tường minh: `QUEUED → LEASED → DISPATCHING → SENT`,
  cùng các nhánh `FAILED`, `UNKNOWN`, `DEAD_LETTER` (bốn trạng thái cuối là **terminal**).

### Policy quyết định từng lượt gửi

Thứ tự lý do từ chối là **cố định**, không phải "gặp cái nào báo cái đó":

```text
GLOBAL_STOP → MODE_PAUSED → ACCOUNT_PAUSED → CAMPAIGN_CANCELLED → TAKEOVER_ACTIVE
→ SUPPRESSED → CONSENT_MISSING → QUIET_HOURS → RATE_LIMITED
→ GROUP_NOT_ALLOWLISTED → GROUP_DIRECTORY_STALE → (ALLOWED)
```

Schema ràng buộc `decision = ALLOW` **khi và chỉ khi** `reason = ALLOWED`.

### Rollout 11 bậc

`FOUNDATION → INFRASTRUCTURE → WAITING_OWNER_QR → CONNECTION → SHADOW → WAITING_OWNER_INBOUND →
LIMITED_OBSERVING → LIMITED_VERIFIED → PROACTIVE → SALES_GROUPS → COMPLETE`

Chỉ **hai** bậc chờ con người: `WAITING_OWNER_QR` và `WAITING_OWNER_INBOUND`. Dọn dẹp sau smoke test
ràng `remainingCount` phải bằng `0` — không có "gần sạch".

## 4. Contract và canonicalization

`contracts/openclaw-zalo/` có 9 schema JSON: `control`, `runtime`, `inbound`, `policy`, `media`,
`receipts`, `maintenance`, `audit`, `state-machine`.

`golden-vectors.json` là thứ giữ cho **bốn runtime khác nhau** (TypeScript trên trình duyệt, Node ở
service, Deno ở edge, và SQL) tính ra **cùng một hash** trước khi ký: thuật toán `RFC8785-JCS+SHA-256`,
mỗi vector kèm chuỗi domain-separation kết thúc bằng NUL. Sinh lại bằng `npm run gen:openclaw:vectors`.

## 5. Bảo mật — cơ chế nào bảo vệ gì

| Cơ chế | Bảo vệ điều gì |
|---|---|
| Session crypto daemon | Phiên Zalo trên đĩa; ghi atomic + durable, báo lỗi rõ khi **không chắc** đã bền |
| QR encryption key | QR chỉ tồn tại dạng ciphertext trong DB — client gọi thẳng RPC **không bao giờ** lấy được QR |
| Runtime token | Credential dài hạn không đi trên request; token ngắn hạn ràng buộc method + path + hash body |
| Object ticket | Trình duyệt không biết bucket/key, chỉ xin `GET` theo `mediaId`; ES256, TTL 60 giây |
| Gateway receipt | Biên lai ký cho upload/retention/audit, verify tại ranh giới Runtime |
| Redaction | Log không bao giờ chứa token, cookie, session, credential, QR payload, số điện thoại, IMEI |
| Egress allowlist | Chỉ ba đích được duyệt; fail-closed khi DNS trả lẫn địa chỉ public và private |
| Fencing / generation | Chống split-brain giữa cell cũ và mới; thu hồi lan sang cả media gateway |

## 6. Phân quyền

Module `openclaw_zalo` có **8 action** — nhiều nhất hệ thống, vì mỗi mức rủi ro tách riêng:

| Action | Mức | Cho phép |
|---|---|---|
| `view` | view | Vào trang |
| `send` | manage | Gửi tin thủ công |
| `manage_knowledge` | manage | Tri thức và bản nháp AI |
| `manage_handoff` | manage | Tiếp quản, bàn giao hội thoại |
| `manage_connections` | **elevated** | Kết nối, ngắt kết nối, đăng nhập QR |
| `manage_automation` | **elevated** | Xuất bản tự động hoá và lịch gửi |
| `manage_operations` | **elevated** | GLOBAL_STOP, xử lý UNKNOWN |
| `audit` | **elevated** | Nhật ký và bằng chứng vận hành |

Khi flag tắt, `openclaw_zalo` **bị loại khỏi danh sách trang** trong permission picker — không chào mời
quyền cho tính năng chưa ship. Riêng legal hold còn đòi thêm **membership OWNER đang hoạt động**, không
chỉ permission.

## 7. Vận hành

11 runbook trong [docs/openclaw-zalo/runbooks/](../openclaw-zalo/runbooks/): `operations` (checklist
hằng ngày), `deploy`, `rollback`, `backup-restore`, `capacity`, `secret-rotation`, `vps-migration`,
`rollout-engine`, `load-test-results`, `merge-to-main-checklist`, `production-ledger-state`.

Vài ràng buộc đáng nhớ:

- **Rollback là forward-compatible và giữ nguyên bằng chứng**: không drop bảng OpenClaw, không xoá audit
  hay UNKNOWN, không copy dữ liệu phiên, không đụng legacy.
- **Di chuyển VPS thì đăng nhập QR lại**, mặc định **không bao giờ** copy session state sang host mới.
- **Chưa biết transfer quota thì chặn** proactive và media nhóm — không đoán rồi chạy.
- Supabase và R2 là nguồn canonical; VPS không giữ dữ liệu không thể dựng lại.

## 8. Những điều dễ hiểu sai

1. **Permission không nói tính năng đã tồn tại.** Quyền `openclaw_zalo.view` đã cấp cho owner mọi tổ
   chức, nhưng quyền trả lời "ai *được* dùng", không trả lời "đã ship chưa". Việc chặn nằm ở feature
   flag, và `demo` **bị từ chối trong build production** để một biến môi trường lạc không mở cockpit
   trên site thật.
2. **`openClawRpc.ts` là lỗ duy nhất được phép cast.** Trước đây bốn call site tự cast riêng lẻ, và
   chính cơ chế đó khiến contract media-resolve từng ship hỏng. Facade cho tên RPC là union được trình
   biên dịch kiểm, còn **kết quả cố ý để `unknown`** — payload phải được chứng minh bằng Zod chứ không
   bằng generated type. Hàm write **bắt buộc** truyền `clientOperationId`, nên không lượt ghi nào quên
   idempotency.
3. **Clamp giá trị bất thường là che lỗi.** Bản cũ `min(seconds, 120)` biến một bất thường *thấy được*
   thành bất thường *vô hình*; nay hệ báo `qrLifetimeIsAnomalous` thay vì tự nắn.
4. **Từng có "khoá do bịa ra".** Logic re-arm disclosure theo `session_risk_state = 'LIMITED'` khoá nút
   vĩnh viễn — trong khi **không migration nào từng ghi giá trị đó**. Bài học: đừng suy trạng thái từ
   giá trị mà schema không bảo đảm sẽ tồn tại.
5. **Chỉ ba file được phép chạm đường giao hàng.** Gate isolation cấm gọi RPC generic `send` và các verb
   `sendText/sendMedia/sendLink/sendReaction/deliver` ở mọi nơi khác — kể cả trong YAML/JSON config.
6. **Gate isolation parse bằng trình biên dịch TypeScript**, không phải chỉ regex, nên không thể lách
   bằng cách xuống dòng hay đổi khoảng trắng.

## 9. Kiểm chứng

```bash
npm run test:openclaw:services   # vendor → session-crypto → bridge → maintenance → egress → watchdog → edge
npm run test:openclaw:sql        # ~14 harness SQL + migration + concurrency
npm run test:openclaw:r2         # media gateway
node scripts/check-openclaw-isolation.mjs   # ranh giới với domain Zalo cũ (chạy trong CI)
```

`test:openclaw:services` **tự chặn** nếu Node không phải v24.15.0–24.x. Đây là lý do repo có nhiều ràng
buộc runtime khác nhau — xem `PROJECT_CONTRACT.md` mục runtime.
