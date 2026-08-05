# Trung tâm mạng (Network Center)

> **Reviewed:** 2026-08-06. Route `/network-center`. Quản trị fleet router MikroTik/RouterOS nhiều toà
> nhà: giám sát liên tục và thực thi **đúng 4 thao tác** đã được đóng khung. Aruba chỉ **phát hiện và
> hiển thị**, không có credential và không ghi gì.

## 1. Vai trò nghiệp vụ

Domain này không phục vụ khách thuê — nó phục vụ **người vận hành hạ tầng**. Mỗi toà nhà có một router
MikroTik; Network Center gom chúng thành một fleet để theo dõi cổng, thiết bị kết nối, sự cố/SLA, cấu
hình và lịch sử thay đổi, đồng thời cho phép can thiệp từ xa trong phạm vi rất hẹp.

Mười tab nghiệp vụ (`NETWORK_CENTER_TABS` trong [src/lib/network-center/model.ts](../../src/lib/network-center/model.ts)):
Tổng quan · Cổng giao tiếp · Thiết bị kết nối · Aruba & sơ đồ · Sự cố & SLA · Cấu hình · Sao lưu & so
sánh · Thay đổi · Nhật ký & Bảo mật · Cài đặt.

### Bốn thao tác được phép — và chỉ bốn

| Thao tác | Rủi ro | Ràng buộc |
|---|---|---|
| `flush_dns_cache` | Thấp | — |
| `renew_dhcp_lease` | Trung bình | — |
| `cycle_access_port` | Trung bình | Phải gõ đúng router identity; **chỉ** port role `lan`, không đụng `protected`; thời lượng 5–30 s |
| `reboot_router` | Cao | Phải gõ đúng router identity |

Đây là danh sách đóng (`NETWORK_ACTION_DEFINITIONS`). Muốn thêm thao tác là đổi contract + migration +
verifier, không phải thêm một nút.

### Ba mức rollout theo từng toà

`NetworkRolloutState` = `OFF` · `READ_ONLY` · `EXECUTE`. Thao tác chỉ chạy khi toà đó ở `EXECUTE`
(`allowsNetworkExecution`). Nghĩa là một toà có thể đang được giám sát đầy đủ mà vẫn không ai bấm được
nút nào — đó là trạng thái mặc định khi mới lên.

## 2. Kiến trúc runtime

```text
Trình duyệt (React)
   │  RPC network_center_*_v1  +  Realtime
   ▼
Supabase Postgres ──► Edge network-center-worker (x-network-worker-secret)
   ▲                  Edge network-watchdog     (x-network-watchdog-secret)
   │  RPC *_v2 (service-role)
Worker Node (VPS Vultr, Docker)
   │  SSH key-only, pin host-key fingerprint
   ▼
RouterOS tại từng toà  ◄── WireGuard wg0 (một file cấu hình dùng chung 15 toà)
```

- **Trình duyệt không bao giờ nói chuyện trực tiếp với router.** Nó chỉ gọi RPC `*_v1` và nghe Realtime.
- **Worker** ([infra/network-center-worker/](../../infra/network-center-worker/)) chạy Docker trên VPS:
  image bất biến theo SHA, `pull_policy: never`, non-root `10001:10001`, `read_only: true`,
  `cap_drop: ALL`, `no-new-privileges`, giới hạn 0.5 CPU / 512 MiB / 128 pids.
- **Secret không nằm trong `.env`** mà ở `/run/secrets/network-center/`; pointer release khoá cả image
  ID lẫn thế hệ secret.
- **Realtime** chỉ 5 bảng: `network_device_current`, `network_interface_current`, `network_incidents`,
  `network_command_events`, `network_worker_building_status` — kênh `network-center-<actorId>`.

## 3. Luồng dữ liệu

Worker SSH đọc RouterOS → gọi Edge `ingest`/`inventory` → RPC `network_center_worker_ingest_v2` ghi
đồng thời ba tầng:

1. **Hiện tại** (ghi đè): `network_device_current`, `network_interface_current`, `network_client_current`
2. **Thô** (append-only, partition theo ngày): `network_device_samples`, `network_interface_samples`
3. **Tổng hợp**: `network_metric_hourly`, `network_sla_daily`; lịch sử phiên: `network_client_sessions`

### Partition và retention

Partition tên `network_{device,interface}_samples_YYYYMMDD`, tạo trước bởi
`network_center_ensure_raw_partitions_v1`. Retention: dữ liệu thô **14 ngày** (DROP partition), rollup
giờ **13 tháng**, SLA ngày **36 tháng**; Aruba discovery 30 ngày, alias 90 ngày, quarantine 7 ngày.

> ⚠ **Partition này là lý do `types.ts` từng phình.** Chúng sinh mỗi ngày nên **không** được coi là API
> frontend: `npm run types:normalize` loại chúng khỏi generated types, và fingerprint catalog cũng bỏ
> qua chúng. Đừng dùng tổng số bảng trong `pg_class` làm con số thiết kế — xem
> [docs/DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md).

## 4. Bật/tắt và phân quyền

`VITE_NETWORK_CENTER_MODE` đọc tại **một chỗ duy nhất**
([src/lib/network-center/runtime.ts](../../src/lib/network-center/runtime.ts)):

| Giá trị | Hành vi |
|---|---|
| `production` | bật, dùng `supabaseRepository` |
| `demo` | bật, dùng `demoRepository` — **tự ép về `off` khi build production** |
| khác / không đặt | `off` |

Khi `off`, route `/network-center/*` **không được đăng ký** trong `App.tsx` — không phải ẩn nút, mà là
không tồn tại đường vào.

Quyền: module `network_center` với hai action — `view` (xem) và `execute` (thực thi, mức `elevated`).
Tài khoản chỉ có `view` sẽ thấy đầy đủ số liệu nhưng mọi thao tác bị chặn.

## 5. Vận hành

- **Runbook dựng router**: [infra/network-center-worker/docs/DEMO-ROUTER-RUNBOOK.md](../../infra/network-center-worker/docs/DEMO-ROUTER-RUNBOOK.md)
  — 10 mục, từ điều kiện dừng, giữ đường phục hồi, sinh key, WireGuard, pin SSH host key, đến chạy
  read-only trước rồi mới thử thao tác.
- **Runbook host worker**: [infra/network-center-worker/README.md](../../infra/network-center-worker/README.md).
- **Rollout**: `scripts/network-center-rollout-manifest.json` khoá sha256 từng migration và từng file
  Edge function, kèm preflight. `npm run network-center:validate` / `:apply` / `:audit`.
  Live apply **bị chặn khi chạy trong GitHub Actions**.
- **Kill switch**: `NETWORK_CENTER_EMERGENCY_STOP` (toàn hệ) và `changesPaused` (từng toà).
- **Watchdog**: pg_cron `*/2 * * * *` cho liveness, `17 * * * *` cho maintenance. HTTP status là kênh
  cảnh báo thật: 200 khoẻ · 503 fleet không khoẻ hoặc không xác định được · 401 sai secret.

## 6. Những điều dễ hiểu sai

1. **`EMERGENCY_STOP` là "đóng băng ghi", KHÔNG phải dừng hẳn.** Polling read-only **vẫn SSH vào router
   production**, heartbeat vẫn gửi nhãn `PAUSED`, maintenance và ingest vẫn chạy. Muốn dừng thật phải
   `docker compose stop` / `systemctl stop`. Bật cờ này **không bao giờ tự revert** và trả
   `health: "unverified"`.
2. **`wg0.conf` là file dùng chung cho cả 15 toà.** Hành vi cũ ghi đè nguyên file đã xoá sạch peer đã
   onboard. Nay merge theo `PublicKey`, chỉ xoá peer khi chỉ đích danh, và cấm `AllowedIPs` chồng dải
   (so theo subnet thật, không so chuỗi).
3. **`UNCERTAIN` không tự chạy lại.** Cycle port hoặc reboot làm mất kết nối ngay sau khi gửi lệnh, nên
   worker không thể tự khẳng định kết quả. Nó arm sẵn một `/system/scheduler` guard trên router trước
   khi ngắt, và ghi bằng chứng durable. **Không được tự retry** — thao tác không idempotent mà retry là
   cách tạo ra lần reboot thứ hai.
4. **Heartbeat cố ý "nói thật".** Nó **không** mang `connections`/`successfulPolls`/`failedPolls`, vì
   phía RPC sẽ đóng dấu `poll_observed_at = now()` khi thấy bất kỳ key nào trong ba key đó — tức là chế
   ra bằng chứng poll tươi giả. `DEGRADED` là sàn trung thực khi chưa có bằng chứng.
5. **`settings: null` nghĩa là toà chưa provisioning**, khác hẳn "đang dùng cài đặt mặc định".
6. **`detailError` không được thay bằng dữ liệu bịa.** Khi RPC chi tiết của một toà lỗi, hàng đó vẫn giữ
   số liệu từ RPC hạm đội và UI phải nói rõ là chưa tải được.
7. **Không còn binary backup.** `/system/backup/save` đã bị bỏ khỏi đường đi của worker (đo 2026-08-03:
   không bộ policy nào vừa chạy được backup vừa cấm worker đọc private key). Chỉ còn export
   `hide-sensitive` kèm SHA-256.
8. **`network_outbox_deliveries` chưa có consumer nào trong repo** — domain event chưa tới tay người.
   Kênh cảnh báo thực tế hiện nay là HTTP status của `/liveness`.

## 7. Gate và kiểm chứng

| Script | Kiểm gì |
|---|---|
| `verify-network-center-queue.mjs` | Khoá theo org/actor/device, cooldown, và **budget** hàng đợi (1 disruptive/thiết bị, 8/actor, 30/org, 120/org mỗi giờ…) |
| `verify-network-center-retention.mjs` | Partition và retention đúng như migration khai báo |
| `verify-network-center-worker-scope.mjs` | Mỗi route worker v2 có **cả** proof chạy được lẫn control fail-closed khi sai credential |
| `verify-network-center-managed-resources.mjs` | 6 ca trên cluster dùng một lần |
| `verify-network-center-hardening.mjs` | 14 phát hiện bảo mật canonical, mỗi cái phải có regression chạy được **và** control hợp lệ |
| `verify-network-center-test-completeness.mjs` | Fail khi một suite chạy ít test hơn số nó sở hữu — **test bị skip vẫn báo pass** |

Hai cạm bẫy của chính hệ kiểm chứng, đã trả giá thật:

- **Docker DNAT đi vòng qua UFW.** Một Postgres dùng-một-lần từng publish `0.0.0.0:54322` và mở ra
  Internet suốt ba ngày dù firewall chỉ mở 22/80/443 — Docker tự ghi rule nat PREROUTING. Nay mọi DB
  dùng-một-lần bind `127.0.0.1`, không container tạm nào có restart policy, và teardown phải được
  **chứng minh bằng bằng chứng**, không phải "đã gọi lệnh dọn".
- **Test bị skip là pass giả.** Khoảng 56 test host-hardening im lặng skip ngoài Windows trong nhiều
  tuần. `deploymentAssets.test.ts` **cố ý fail trên runner Linux** — đó là tín hiệu suite này chỉ chạy
  được trên Windows, không phải lỗi cần workaround.

Ngoài ra `check-definer-acl.mjs` và `check-view-invoker.mjs` **cố ý không chạy trong CI** (chúng đọc
catalog production bằng PAT) — đó là bước local/release-time, không phải thiếu sót.
