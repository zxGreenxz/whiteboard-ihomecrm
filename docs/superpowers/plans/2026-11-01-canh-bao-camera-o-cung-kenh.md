# Cảnh báo ổ cứng và kênh camera của đầu ghi — plan triển khai

> **Trạng thái:** Chủ duyệt 01/11 ("okie thực hiện cho tôi đi"). Đợt 1 (T1–T6) đang ở draft PR nhánh `claude/canh-bao-camera-o-cung-kenh`. Riêng Q4 (kênh Zalo) vẫn chờ chốt.
> **Ngày:** 01/11/2026.
> **Hiện trạng đối chiếu với:** `origin/main` c104665a0. Phần camera, Network Center và thông báo không lệch so với main local 7a92ad332.
> **Hạng mục riêng.** Không gộp với việc nối toà hay sửa máy vân tay.

## 0. Vì sao cần

- **512TT:** ổ cứng đầu ghi lỗi từ 12/10 18:27 đến 01/11 08:09. Gần 20 ngày không có video mà không ai biết. Khi đó 512TT chưa được nối giám sát. Kể cả đã nối, hệ thống hiện chỉ *ghi lại* chuyển trạng thái ổ `NORMAL→ERROR`, không báo cho ai.
- **15KV:** 194 lần camera mất kết nối trong 10 ngày, phần lớn chỉ 8–20 giây. Kênh 3 và 5 từng treo luồng SD tới khi khởi động lại đầu ghi.

**Mục tiêu** (tính cả poll 60 s và chu kỳ đánh giá 2 phút):
- Ổ lỗi: người phụ trách biết trong **≤ 5 phút**.
- Đầu ghi mất kết nối, sai mật khẩu, hoặc mất dữ liệu giám sát: **≤ 10 phút**.
- Kênh camera mất kéo dài: **≤ 15 phút**.
- Rớt chập chờn vài giây thì không báo.
- Hết lỗi thì có tin báo đã khôi phục.

## 1. Phạm vi

**Trong phạm vi**
- Đánh giá trạng thái đầu ghi đang giám sát: đầu ghi, ổ, kênh, độ mới của dữ liệu.
- Mở và đóng sự cố trong Network Center.
- Gửi thông báo: chuông CRM, web push, và Zalo (đợt 1b).
- Nhắc lại hằng ngày.
- Hiển thị trên tab Camera.

**Ngoài phạm vi**
- Luồng SD bị treo trong đầu ghi, như kênh 3 và 5 của 15KV ngày 01/11. Kênh vẫn báo `Connected` nên trạng thái kênh không đo được. Muốn bắt phải dò RTSP, làm hạng mục sau.
- Máy vân tay offline (Q9).
- Hệ thống tự khởi động lại đầu ghi (Q8).
- Email và Telegram: repo chưa có mã gửi.
- Cảnh báo WAN hoặc cổng router.
- Lấy bù nhật ký cũ của đầu ghi.

## 2. Quyết định

Các mặc định dưới đây mình đã đề xuất cho chủ ngày 01/11. Chủ bảo "làm plan", chưa duyệt từng câu. Câu nào cũng sửa được trước khi code.

| # | Câu hỏi | Đề xuất | Ghi chú sau khi tra code |
|---|---|---|---|
| Q1 | Báo những lỗi nào | Ổ lỗi; đầu ghi mất kết nối hoặc sai mật khẩu; mất dữ liệu giám sát; kênh mất kéo dài; báo cả lúc hết lỗi | Thêm "mất dữ liệu giám sát", vì collector chết thì hiện không ai biết (§3.4) |
| Q2 | Ngưỡng chống báo nhầm | Ổ `ERROR`: báo ngay. Đầu ghi `OFFLINE`/`AUTH_DENIED`: ≥ 5 phút. Mất dữ liệu: ≥ 5 phút. Kênh mất: ≥ 10 phút | Kênh chỉ xét khi đầu ghi `ONLINE` (bẫy B2) |
| Q3 | Báo cho ai | Chủ công ty, cộng thành viên ACTIVE có `network_center.view` ở đúng toà | Chưa có hàm dùng chung, phải viết mới (§4.5) |
| Q4 | Kênh báo | ~~Zalo (bot Hermes) cho chủ~~ + chuông cho quản lý | **Phải chốt lại.** Hermes chỉ trả lời DM, không gửi chủ động được. Web push prod không có thiết bị từ 05/10 (cần kiểm lại). Xem §4.10 |
| Q5 | Nhắc lại | Sự cố chưa đóng: bản tin nhắc mỗi ngày lúc 08:00. Nhiều sự cố cùng lúc gom thành một tin | Sự cố đã ghi nhận (`ACKNOWLEDGED`) thì không nhắc |
| Q6 | Ban đêm | CRITICAL báo ngay 24/7. WARNING (kênh lẻ) phát sinh 22:00–07:00 thì dồn bản tin 07:00 | Không dùng giờ yên của PR #275 (§3.6) |
| Q7 | Kiểm "còn ghi hình không" | Có. Mỗi 30–60 phút dò file ghi mới (`mediaFileFind`) | Cần sửa collector, nên tách đợt 2 |
| Q8 | Tự khởi động lại đầu ghi | Không, chỉ báo | — |
| Q9 | Máy vân tay offline | Để hạng mục sau | — |
| Q10 | Lưu plan | `docs/superpowers/plans/` (theo `docs/plans/README.md`) | File này |

## 3. Hiện trạng (có bằng chứng)

### 3.1 Đường dữ liệu

Đầu ghi → `ihome-camera-monitor` → outbox trên đĩa → Edge `camera-ingest` → RPC ingest → `camera_recorder_current` (mỗi đầu ghi một dòng, ghi đè) và `camera_events` (nối thêm).

**Collector**
- Poll theo `pollIntervalSeconds`, mặc định 60 s: `infra/network-center-worker/src/cameraRuntime.ts:64-78`.
- Luồng sự kiện `VideoLoss`, `StorageFailure`, `StorageNotExist`, `StorageLowSpace`: `cameraRuntime.ts:79-108`, `src/camera/dahuaClient.ts:357`.
- Rớt luồng thì ghi `COVERAGE_GAP`.
- Danh sách đầu ghi nạp lại mỗi 30 s: `cameraRuntime.ts:161`.

**Trạng thái** (`dahuaClient.ts:85-88, 318-332`)
- Ổ là `ERROR` khi có `Detail[n].IsError=true`, là `NORMAL` khi `State=Success` và không có lỗi. Còn lại là `UNKNOWN`.
- Đầu ghi `OFFLINE` chỉ khi không kết nối được trước bước đăng nhập. `AUTH_DENIED` khi bị 401/403.

**Ingest và chuyển trạng thái**
- Migration `supabase/migrations/20261022145352_network_center_camera_monitoring_v1.sql`, đã áp prod 22/10. RPC ingest ở :182-304.
- DB đã sinh sẵn sự kiện chuyển trạng thái, có chống lặp qua restart và replay:

  | Kind | Ý nghĩa | Dòng |
  |---|---|---|
  | `RECORDER` | Đổi trạng thái đầu ghi | :273-276 |
  | `CHANNEL` | Đổi trạng thái kênh, bỏ qua lần đầu | :281-289 |
  | `STORAGE` | Đổi trạng thái ổ theo slot | :290-297 |
  | `DEVICE` | Sự kiện thô từ luồng | :253-266 |

  Ràng buộc chống trùng: `UNIQUE(recorder_id,event_key)` ở :61.

### 3.2 Chưa có gì phản ứng với sự kiện

- Không có trigger, cron, outbox hay publication realtime nào cho `camera_*`.
- `stale_after_seconds` (mặc định 180) chỉ được đọc ở trình duyệt: `src/lib/network-center/cameraContracts.ts:71-76`.
- Tab Camera chỉ poll 30 s khi đang mở: `src/hooks/network-center/useBuildingCameras.ts:61,73`.
- Camera không có trong `FleetOverview`, `IncidentRail` hay chuông.

### 3.3 Bẫy phải xử lý

| # | Bẫy | Bằng chứng | Hệ quả cho thiết kế |
|---|---|---|---|
| B1 | Ổ `ERROR` hoặc kênh mất thì `status` đầu ghi **vẫn `ONLINE`** | `dahuaClient.ts:318-326` | Phải đọc `storage[].state` và `channels[].state` |
| B2 | Đầu ghi khác `ONLINE` thì server ép mọi kênh và ổ thành `UNKNOWN`, sinh hàng loạt event `CONNECTED→UNKNOWN` | migration :252, :272; test `scripts/__tests__/network-center-camera-runtime.sql:32-33` | Chỉ báo ở cấp đầu ghi. `UNKNOWN` không phải lỗi kênh hay ổ |
| B3 | `MISSING` không bao giờ được sinh | `src/camera/types.ts:19`, `dahuaClient.ts:83` | Mất ổ thể hiện thành đầu ghi `UNKNOWN` kéo dài (C6) |
| B4 | `service_role` bị REVOKE khỏi 3 bảng camera | migration :110 | Bộ đánh giá phải là hàm `SECURITY DEFINER` chạy bằng cron |
| B5 | Chỉ VideoLoss có số kênh. Sự kiện ổ không kèm số ổ | `src/camera/eventParser.ts:25`, `cameraRuntime.ts:87-91` | Đợt 1 dựa vào snapshot (`storage[].slot`), không dựa vào sự kiện thô |
| B6 | Collector không gửi heartbeat. Watchdog chỉ canh worker router | `20260729139000_network_center_watchdog.sql:219-266` | Thêm điều kiện "mất dữ liệu giám sát" (C4) |
| B7 | Đầu ghi 15KV (`DHI-NVR1108HS-S3/H-VN`, firmware 4.001.100Zb02.0.R) trả `connectionState: "Unconnect"` cho kênh mất. Parser chỉ nhận `"Unconnected"`/`"Disconnected"` nên kênh đó thành UNKNOWN, kéo cả đầu ghi thành UNKNOWN + `CHANNEL_STATUS_UNAVAILABLE`, và server ép mọi kênh/ổ thành UNKNOWN (đo trên prod 02/11 14:13) | `infra/network-center-worker/src/camera/dahuaClient.ts:41-43` | Đã vá trong cùng PR (commit riêng): `"Unconnect"` ⇒ DISCONNECTED, giữ so khớp phân biệt hoa thường. Chưa vá thì C5 không bao giờ bật trên 15KV, chỉ có C6. Collector cần phát hành riêng |

### 3.4 Sự cố Network Center tái dùng được

**Bảng `network_incidents`** (`20260729030000_network_center_operations.sql:9-77`)
- `severity`: INFO / WARNING / CRITICAL.
- `status`: OPEN / ACKNOWLEDGED / RECOVERING / RESOLVED.
- Index unique đảm bảo mỗi `(org, building, fingerprint)` chỉ có một sự cố đang mở.
- `incident_type` chỉ cần khớp regex `^[A-Z][A-Z0-9_]{2,63}$`, không có danh sách cứng.
- `device_id` **NOT NULL**, FK sang `network_devices`. Camera lấy device qua `camera_recorder_connections.router_connection_id → network_device_connections.device_id`.

**Khuôn mở và đóng sự cố bằng SQL**
- Watchdog: `20260729139000_network_center_watchdog.sql:395-572`.
- Dùng `INSERT … ON CONFLICT … WHERE status <> 'RESOLVED'`, trả `(xmax = 0) AS newly_opened`.
- Ghi kèm `network_incident_events` (OPENED/RESOLVED), audit SYSTEM, outbox. Cron chạy `*/2`.

**Không dùng được**
- RPC worker `upsert_incident_v2` đòi `|now − observedAt| ≤ 600 s` (`20260729040000_…:2537`).

**Đã sẵn**
- UI "Sự cố & SLA" hiển thị mọi sự cố của toà (`src/components/network-center/tabs/IncidentsTab.tsx:42-60`).
- `network_incidents` đã có realtime.
- Có cửa sổ bảo trì theo toà (`20260729030000_…:127-173`).

### 3.5 Thông báo

| Kênh | Hiện trạng | Bằng chứng |
|---|---|---|
| Chuông CRM | **Dùng được.** `public.notifications`, realtime INSERT theo user. Khuôn tốt nhất: `zalo_canh_gac_bao_v1` ghi `type='CUSTOM'`, `channel='IN_APP'`, `metadata.url` | `supabase/baseline/schema.sql:110743-110770`; `src/hooks/useNotifications.ts:402-416`; `20261009171352_zalo_canh_gac_worker.sql:112-164` |
| Web push | Gửi ngay qua `pg_net` → Edge `send-push`. JWT lấy từ Vault bằng `app_private.lifecycle_reminder_service_jwt_v1()`, hàm này ném lỗi trên DB TEST đã đánh dấu. `idempotencyKey` bắt buộc, chống trùng bằng `push_send_log`. **Prod không có thiết bị đăng ký từ 05/10** (memory ngày 21/10, cần kiểm lại) | `20260928042301_lifecycle_reminder_cron.sql:6-24`; `supabase/functions/send-push/index.ts:181-217` |
| Zalo | **Chưa có đường gửi cảnh báo.** Worker CRM gửi tin vào hội thoại có sẵn qua `zalo_send_queue`. Hermes native chỉ trả lời DM đã ghép | `worker/lib/queue.js:1-20`; `20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql`; `infra/hermes-zalo-native/README.md:14,43` |
| Email / Telegram | Không có mã gửi | — |

### 3.6 Lệch PR #275 (giờ yên, drain 15 phút)

- PR #275 là draft và đang CONFLICTING. Migration của nó đã áp lên prod, nhưng main **không có** các file đó.
- Vì vậy migration mới **không được tham chiếu** `notify_push_allowed_now_v1`, nếu không replay sẽ lỗi.
- Luật ban đêm của cảnh báo camera phải tự làm (Q6).

### 3.7 Quyền

- Camera dùng chung quyền `network_center.view`, có scope BUILDING (`20260729010000_network_center_permissions_inventory.sql:26-51`).
- `can_do_on_building` chạy theo `auth.uid()`, nên dùng trong cron sẽ không có actor.
- Khuôn liệt kê người nhận: `app_private.ie_approver_ids_v1` (`20260729151000_notify_helpers.sql:61-96`). Hàm này lấy membership ACTIVE rồi gọi `authorize_tenant_action_v3(user, org, '<quyền>', building, NULL)`.
- Khuôn lấy chủ công ty: `app_private.ie_actor_is_company_owner_v1`.
- Spec `2026-08-12-network-center-operational-observability-h196a-design.md` §10 yêu cầu kiểm lại membership và quyền ngay lúc gửi.

## 4. Thiết kế

### 4.1 Tổng quan

```
camera_recorder_current (đã có, collector ghi mỗi 60 s)
        │  pg_cron */2 phút
        ▼
app_private.camera_alert_evaluate_v1(now)  ── SECURITY DEFINER, advisory lock
        │ 1. tính điều kiện xấu theo đầu ghi  →  camera_alert_conditions (first_seen/last_seen)
        │ 2. đủ ngưỡng  → mở network_incidents CAMERA_* (+ incident_events, audit)
        │ 3. hết lỗi 2 lượt liên tiếp → RECOVERING → RESOLVED
        │ 4. gom tin theo người nhận → camera_alert_deliveries (ledger, chống trùng)
        ▼
chuông (notifications CUSTOM) · web push (pg_net → send-push) · Zalo (đợt 1b)
```

Không sửa collector ở đợt 1. Mọi thứ chạy bằng SQL và cron, theo đúng khuôn watchdog.

### 4.2 Điều kiện, ngưỡng và cách đóng

Chung cho mọi điều kiện:
- Fingerprint: `camera:<recorder_id>:<subject>`, độ dài 8–200.
- `observed_values` gồm `recorderId`, `recorderName`, `channel` / `slot`, `firstSeenAt`, `thresholdSeconds`, `detectedBy:'camera-alert'`.

| Mã | Mức | Điều kiện (đọc từ `camera_recorder_current`) | Ngưỡng | Đóng khi |
|---|---|---|---|---|
| C1 `CAMERA_STORAGE_ERROR` | CRITICAL | `status='ONLINE'` và có `storage[].state='ERROR'`. Subject `storage:<slot>` | báo ngay (lượt đánh giá đầu tiên thấy lỗi) | 2 lượt liên tiếp ổ NORMAL |
| C2 `CAMERA_RECORDER_OFFLINE` | CRITICAL | `status='OFFLINE'` | ≥ 5 phút | 2 lượt liên tiếp đầu ghi ONLINE |
| C3 `CAMERA_RECORDER_AUTH_DENIED` | CRITICAL | `status='AUTH_DENIED'` (đổi mật khẩu thì giám sát mù) | ≥ 5 phút | như C2 |
| C4 `CAMERA_MONITOR_STALE` | CRITICAL | `now − checked_at ≥ max(stale_after_seconds, 300 s)`, hoặc vẫn chưa có snapshot 10 phút sau khi enroll | báo ngay khi điều kiện đúng (điều kiện đã gồm 5 phút) | có snapshot mới |
| C5 `CAMERA_CHANNEL_LOST` | WARNING (≥ 50 % kênh cùng mất thì nâng CRITICAL) | `status='ONLINE'` và `channels[].state='DISCONNECTED'`. Subject `channel:<n>` | ≥ 10 phút liên tục | 2 lượt liên tiếp CONNECTED |
| C6 `CAMERA_RECORDER_UNKNOWN` | WARNING | `status='UNKNOWN'` (ổ không đọc được hoặc phản hồi lạ, xem B3) | ≥ 30 phút | đầu ghi khác UNKNOWN |
| C7 `CAMERA_NOT_RECORDING` (đợt 2) | CRITICAL | kênh CONNECTED nhưng không có file ghi mới | ≥ 2 giờ | có file mới |

**Quy tắc loại trừ**
- C2, C3, C4 đang mở thì không mở hoặc giữ C1, C5, C6 của cùng đầu ghi (bẫy B2).
- Nhiều đầu ghi cùng bị C4 trong một lượt: tin nhắn ghi "có thể do VPS hoặc bộ thu thập", không phải lỗi từng đầu ghi.
- Đầu ghi `enabled=false` thì không xét, và đóng các sự cố đang mở với lý do `DISABLED`.

**Đóng sự cố có trễ.** Lượt đầu tiên hết lỗi thì chuyển `RECOVERING`, lượt thứ hai mới `RESOLVED`. Như vậy rớt rồi có lại ngay không sinh cặp tin mở/đóng liên tục.

Rớt chập chờn ở 15KV (8–20 s) không vượt ngưỡng 10 phút, nên không mở sự cố.

C5 phụ thuộc collector đọc đúng chuỗi trạng thái kênh của từng firmware (bẫy B7). Với 15KV, C5 chỉ có tác dụng sau khi bản collector có `"Unconnect"` được phát hành.

**Điều chỉnh lúc triển khai Đợt 1 (02/11, sau review chéo):**
- C4 chờ thêm 90 giây kể từ lượt đầu thấy dữ liệu cũ (`monitorGraceSeconds`). Lý do: bật lại theo dõi một đầu ghi còn snapshot cũ sẽ báo CRITICAL giả trước khi collector kịp poll. 90 giây nhỏ hơn nhịp cron, nên C4 luôn mở ở lượt kế tiếp; collector chết vẫn lộ trong ≤ 10 phút.
- Độ mới tính theo lần muộn hơn giữa `checked_at` và `received_at`, để đồng hồ VPS chậm không biến mọi đầu ghi thành C4. Ngưỡng cũ cũng không nhỏ hơn 2 chu kỳ poll của đầu ghi.
- C2 **đã mở** thì đóng khi đầu ghi kết nối lại được (`ONLINE`, `UNKNOWN` hoặc `AUTH_DENIED`); C3 đã mở thì đóng khi `ONLINE` hoặc `UNKNOWN`. Nếu chỉ đóng khi `ONLINE`, C2 sẽ kẹt mở và che mất C6 khi đầu ghi trả `UNKNOWN`. Khi C2/C3 **chưa mở**, chỉ `ONLINE` mới xoá bộ đếm; `UNKNOWN` giữ nguyên bộ đếm, để đường truyền chập chờn OFFLINE ↔ UNKNOWN vẫn mở C2 sau 5 phút. C6 vẫn chỉ đóng khi `ONLINE`.
- C1/C5/C6 bị C2/C3/C4 che thì đóng lặng với lý do `SUPERSEDED`, không gửi tin "đã khôi phục".
- Router của connection bị gỡ: đóng lặng sự cố với lý do `ROUTER_UNAVAILABLE`, giống trường hợp `DISABLED`.
- Tỷ lệ ≥ 50 % và việc nâng mức chỉ tính kênh đang mất ở chính lượt đánh giá đó; kênh đang hồi phục không bị nâng.
- Tin hoãn ban đêm quá 24 giờ thì đóng sổ là `SUPPRESSED`, không gửi, và không tính là "đã báo mở".
- Hết cửa sổ bảo trì mà lỗi vẫn còn thì báo một lần.
- Lịch cron (T4) nằm cùng file migration, không tách riêng. Lý do: cửa idempotent dán từng file lên production, nên một file lịch đòi hàm của file chưa áp sẽ ngã ở đó. Không có schema `cron` thì bỏ qua, theo khuôn `zalo_canh_gac`.

### 4.3 Bảng mới (đều trong `app_private`, chỉ hàm SECURITY DEFINER đụng tới)

**`camera_alert_settings`** — mỗi org một dòng:
- `enabled` mặc định `false`.
- `mode`: `SHADOW` hoặc `LIVE`.
- `night_start` 22:00, `night_end` 07:00, `digest_at` 08:00.
- `thresholds jsonb` (giá trị §4.2).
- `zalo_target jsonb NULL` (đợt 1b).

**`camera_alert_conditions`**
- Khoá chính `(recorder_id, subject)`.
- Cột: `condition_code`, `first_seen_at`, `last_seen_at`, `clear_streak`, `incident_id`, `observed jsonb`.

**`camera_alert_deliveries`** — ledger:
- Cột: `id`, `organization_id`, `batch_id`, `incident_id`, `recipient_user_id` (NULL với Zalo), `channel` (IN_APP/PUSH/ZALO), `kind` (OPENED/RESOLVED/DIGEST/NIGHT_DIGEST), `dedup_key` UNIQUE, `status`, `result jsonb`, `created_at`, `sent_at`.
- `dedup_key = kind:incident:recipient:channel[:ngày]`.

### 4.4 Mở và đóng sự cố

- Chép khuôn watchdog (§3.4): `INSERT … ON CONFLICT (organization_id, building_id, fingerprint) WHERE status <> 'RESOLVED' DO UPDATE …`.
- `device_id` lấy từ router của connection camera. Nếu router đã bị gỡ thì bỏ qua đầu ghi đó, ghi log, không ném lỗi cả lượt.
- Tiêu đề và tóm tắt viết tiếng Việt cho người vận hành, ví dụ: "Ổ cứng đầu ghi 512TT báo lỗi — đầu ghi có thể không lưu được video".
- Sự cố có cửa sổ bảo trì đang hiệu lực thì vẫn ghi, nhưng không gửi thông báo. `observed_values.maintenance=true`.

### 4.5 Người nhận

- Hàm mới `app_private.network_center_alert_recipient_ids_v1(p_org, p_building)`.
- Người nhận = chủ công ty (`ie_actor_is_company_owner_v1`) ∪ thành viên `organization_memberships` ACTIVE có `authorize_tenant_action_v3(user, org, 'network_center.view', building, NULL)`.
- Loại super admin ở org sandbox/demo, theo khuôn `lifecycle_recipient_allowed_v1`.
- Lọc NULL trong mảng loại trừ (bẫy đã ghi ở `ie_approver_ids_v1`).
- Kiểm lại ngay lúc gửi, không cache danh sách.

### 4.6 Gửi

- **Gom tin:** mỗi lượt đánh giá, mỗi người nhận nhận **một** tin cho mọi sự cố mới và đã khôi phục.
  - Ví dụ tiêu đề "Camera: 2 sự cố mới". Nội dung "512TT · Ổ cứng lỗi (08:12) / 15KV · Kênh Hầm 2 mất 12 phút".
  - Nhiều toà thì đường dẫn trỏ toà đầu tiên, nội dung liệt kê đủ.
- **Chuông:**
  - `INSERT public.notifications (organization_id, user_id, type='CUSTOM', channel='IN_APP', status='PENDING', subject, content, metadata)`.
  - `metadata = {v5:'camera_alert', url:'/network-center/buildings/<buildingId>?tab=cameras', incidentIds:[…], batchId}`.
- **Push:**
  - `net.http_post` tới `send-push` với `idempotencyKey = 'camera-alert:' || batch || ':' || user`, `tag = 'camera-alert'`.
  - JWT lấy bằng `lifecycle_reminder_service_jwt_v1()`. Lỗi JWT (DB TEST hoặc Vault trống) thì vẫn ghi chuông, và ghi lý do vào ledger, theo khuôn `zalo_canh_gac_bao_v1`.
- **Shadow mode:**
  - Chỉ ghi `camera_alert_conditions` và ledger `status='SHADOW'`, kèm sự cố *dự kiến* (mã, toà, giờ).
  - **Không** mở `network_incidents`, không chèn chuông, không gọi push. Người dùng không thấy gì thay đổi.
  - Banner và sự cố trên UI được nghiệm thu ở TEST (§6.2).

### 4.7 Ban đêm, bản tin và nhắc lại

- Giờ địa phương lấy theo timezone của org (hàm timezone hiện có trên main). Không dùng giờ yên của #275 (§3.6).
- **CRITICAL** gửi ngay ở mọi giờ, bỏ qua giờ yên cá nhân. Đây là quyết định Q6, cần ghi rõ trong UI cài đặt sau này.
- **WARNING** phát sinh trong `[night_start, night_end)` thì ghi ledger `kind='NIGHT_DIGEST'`, gửi gộp lúc `night_end`.
- **Bản tin hằng ngày** lúc `digest_at`:
  - Liệt kê mọi sự cố `OPEN`/`RECOVERING` đã mở ≥ 12 giờ, chưa ở trạng thái `ACKNOWLEDGED`.
  - Ledger chống gửi trùng trong ngày.

### 4.8 Bật tắt và vận hành

- `enabled=false` thì bộ đánh giá không làm gì. Đây là kill switch.
- `mode='SHADOW'` để chạy thử 48 giờ trên org thật.
- Cron `camera-alert-evaluate` chạy `*/2 * * * *`, dùng advisory lock riêng nên không chạy chồng.
- Tắt khẩn: `UPDATE camera_alert_settings SET enabled=false`, hoặc `cron.unschedule('camera-alert-evaluate')`.
- Không drop schema để rollback.

### 4.9 Giao diện

- **`CamerasTab.tsx`:**
  - Thêm dải "Sự cố đang mở" theo đầu ghi, đọc từ `network_incidents` có `incident_type LIKE 'CAMERA_%'` qua RPC đọc có kiểm quyền.
  - Ổ `ERROR` trên đầu ghi `ONLINE` phải nổi bật thành banner đỏ, không chỉ là badge (B1).
- **`IncidentsTab.tsx`:** sự cố `CAMERA_*` hiện sẵn nhờ cột `title`. Thêm bộ lọc "Camera" nếu cần.
- **(Tuỳ chọn)** `FleetOverview` thêm số sự cố camera đang mở theo toà.
- **Chuông:** bấm vào thì mở đúng tab Camera của toà qua `metadata.url`.

### 4.10 Kênh Zalo (đợt 1b) — chờ chủ chọn

| Phương án | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **Z1 (khuyến nghị)** | Hàm SECURITY DEFINER mới ghi vào `zalo_send_queue` cho **một hội thoại chỉ định** (chat của chủ, hoặc nhóm "Kỹ thuật" có tài khoản Zalo của CRM). Hội thoại cấu hình trong `camera_alert_settings.zalo_target`. Worker sẵn có sẽ gửi | Dùng lại hàng đợi và worker đang chạy, ít mã | Gửi tự động từ tài khoản Zalo cá nhân thì có rủi ro chống spam. Phải gom tin, giới hạn ~10 tin mỗi ngày. Cần bản đồ quyền cho đường ghi mới (RPC-only scope) |
| Z2 | Hermes broker có lệnh gửi DM chủ động cho chủ | Tin đến từ trợ lý Hermes | Phải mở hạng mục Hermes riêng, lớn hơn |
| Z3 | Chỉ chuông và push | Không thêm rủi ro | Prod chưa có thiết bị push; chủ phải bật push trên điện thoại |

Đợt 1 làm chuông và push. Chuyển sang `LIVE` chỉ khi **ít nhất máy của chủ nhận được push thử**, hoặc khi đã xong Z1.

### 4.11 Kiểm còn ghi hình (đợt 2, sửa collector)

**`DahuaClient.latestRecording(channel)`**
- Gọi chuỗi `mediaFileFind.cgi` (`factory.create` → `findFile` trong 3 giờ gần nhất → `findNextFile&count=1` → `close`/`destroy`).
- Chạy 30–60 phút một lần cho mỗi đầu ghi, không chạy ở mỗi lượt poll.
- Agent format ổ 512TT ngày 01/11 đã dò được file ghi mới bằng đường này.

**Payload và ingest**
- Snapshot thêm `recording: [{channel, lastEndAt}]`.
- Edge schema `supabase/functions/network-center-worker/index.ts:43-68` và RPC ingest phải nhận trường mới.
- Thêm cột `recording jsonb` cho `camera_recorder_current`. Đây là migration network_center mới.

**Kèm theo**
- Gửi `index` ổ trong sự cố từ luồng sự kiện (B5).
- Phát hành collector theo đúng runbook (`infra/network-center-worker/README.md:462-500`): artifact có hash, `current` trỏ bản đã review, có rollback.

### 4.12 Tải hệ thống khi lên 20 toà

Số đo prod lấy ngày 01/11 08:5x, từ `cron.job_run_details` 24 giờ gần nhất.

**Đang chạy**
- `network_center_watchdog_liveness_v1` đã chạy `*/2`: 720 lượt/ngày, trung bình 34 ms, tối đa 364 ms.
- Tổng mọi job cron khoảng 42 giây DB mỗi ngày, tức khoảng 0,05 % một nhân.
- Camera: 3 đầu ghi, 110 `camera_events` trong 24 giờ, bảng 248 kB. Dòng `camera_recorder_current` tối đa 1,6 KB.

**Bộ đánh giá ở 20 toà**
- Mỗi lượt đọc khoảng 20 dòng `camera_recorder_current` (khoảng 32 KB), tách 160–320 phần tử kênh, đối chiếu vài dòng `camera_alert_conditions`.
- Ước tính 10–40 ms mỗi lượt, tức ≤ 30 giây DB mỗi ngày. Nhẹ ngang hoặc hơn job watchdog đang chạy.

**Phần tăng thật khi lên 20 toà là thu thập (đã có), không phải bộ đánh giá**
- Mỗi đầu ghi gửi snapshot mỗi 60 s. 20 đầu ghi là khoảng 28.800 lần ingest mỗi ngày (0,33 lần/giây).
- Đó cũng là khoảng 0,86 triệu lần gọi Edge `camera-ingest` mỗi tháng. Cần đối chiếu với hạn mức Edge của gói Supabase.
- Nếu cần giảm: tăng `poll_interval_seconds` lên 120 s, hoặc gom nhiều đầu ghi vào một lần gửi (việc của collector, ngoài plan này).
- `camera_events` ước tính 1–2 nghìn dòng mỗi ngày (khoảng 0,5 MB). Khi bảng lớn mới cần thêm luật dọn.

**Ràng buộc để luôn nhẹ**
- Bộ đánh giá chỉ đọc `camera_recorder_current`. **Không** quét lịch sử `camera_events`.
- Chỉ ghi khi điều kiện đổi.
- Advisory lock chống chạy chồng; `SET LOCAL statement_timeout = '5s'`.
- `cron.job_run_details` tăng 720 dòng mỗi ngày, đã có `don_log_cron_v1` dọn.

**Nghiệm thu tải sau khi bật**
- Đọc `cron.job_run_details` của job mới: trung bình < 50 ms, tối đa < 500 ms.
- Vượt ngưỡng thì giãn lịch xuống `*/5`; độ trễ báo tăng thêm tối đa 3 phút.

## 5. Các bước triển khai

### Đợt 1 — phát hiện + sự cố + chuông + push

| Task | Nội dung | File chính | Nghiệm thu |
|---|---|---|---|
| T1 | Migration `network_center_camera_alerts_v1`: 3 bảng §4.3, hàm người nhận §4.5, REVOKE/GRANT đúng khuôn. Thêm vào `scripts/network-center-rollout-manifest.json` | `supabase/migrations/2026110x…_network_center_camera_alerts_v1.sql` | `npm run network-center:validate` xanh; smoke migration trên DB rỗng |
| T2 | `camera_alert_evaluate_v1(now)`: điều kiện C1–C6, mở/RECOVERING/đóng sự cố, loại trừ B2, bảo trì | cùng migration | Test SQL §6.1 xanh |
| T3 | Gom tin, ledger, chuông, push, shadow, ban đêm, bản tin | cùng migration | Test SQL §6.1 xanh; idempotency key không lặp |
| T4 | Cron `*/2`, gắn với `enabled`/`mode` | migration riêng như `lifecycle_reminder_cron` | Cron chạy mà không có org bật thì không làm gì |
| T5 | RPC đọc sự cố camera theo toà (kiểm `network_center.view`), banner ở `CamerasTab`, lọc ở `IncidentsTab` | `src/components/network-center/tabs/CamerasTab.tsx`, `src/lib/network-center/cameraRepository.ts`, `src/hooks/network-center/useBuildingCameras.ts` | Unit `src/lib/__tests__/networkCenterCamerasTab.test.tsx`; e2e `.e2e-fleet/specs/network-center.spec.ts`; Playwright MCP kiểm đúng màn đã đổi |
| T6 | Draft PR (đụng migration và quyền). Review chéo một lượt trên diff cuối theo Contract §3 | — | Biên nhận gate, `gate:truoc-push` |
| T7 | Phát hành, xem §7 | — | — |

### Đợt 1b — Zalo (sau khi chủ chọn Z1/Z2/Z3)

- T8: theo phương án đã chọn.
- Với Z1: thêm hàm ghi hàng đợi có allowlist hội thoại, giới hạn tần suất, thêm `channel='ZALO'` cho ledger.
- Thử trên TEST trước, sau đó mới gửi một tin thật vào hội thoại chủ đã chỉ định.

### Đợt 2 — kiểm còn ghi hình

- T9: collector `latestRecording` và parser, có fixture test trong `infra/network-center-worker/test/`.
- T10: Edge, ingest và cột `recording`, thêm C7.
- T11: phát hành collector có hash và rollback.

## 6. Kiểm chứng

### 6.1 Test SQL (harness PostgreSQL dùng một lần)

Harness: `scripts/test-network-center-camera-disposable.mjs`, thêm file test cạnh `scripts/__tests__/network-center-camera-runtime.sql`.

1. Ổ ERROR trên đầu ghi ONLINE thì mở **một** C1. Chạy lại lượt thì không mở thêm, không gửi thêm.
2. Kênh rớt 8–20 s rồi có lại (mô phỏng 15KV): không mở C5. Mất ≥ 10 phút: mở C5. Có lại 2 lượt: RECOVERING rồi RESOLVED, và có đúng một tin khôi phục.
3. Đầu ghi OFFLINE: chỉ mở C2, không mở C1/C5 dù kênh và ổ thành UNKNOWN (B2).
4. `checked_at` cũ hơn 5 phút: mở C4. Ba đầu ghi cùng cũ: tin ghi "có thể do VPS hoặc bộ thu thập".
5. `enabled=false`: không xét, và đóng sự cố đang mở.
6. Cửa sổ bảo trì: có sự cố, không có tin.
7. Người nhận:
   - Có chủ.
   - Có quản lý toà có quyền.
   - Không có người chỉ có quyền ở toà khác.
   - Không có thành viên INACTIVE.
   - Không có super admin ở org sandbox.
8. WARNING lúc 23:00 được hoãn tới 07:00 rồi gửi gộp. CRITICAL lúc 23:00 gửi ngay.
9. Bản tin 08:00 chỉ chứa sự cố mở ≥ 12 giờ và chưa ghi nhận. Chạy hai lần trong ngày thì lần hai không gửi.
10. SHADOW: chỉ có conditions và ledger, không có `network_incidents`, không có `notifications`, không có `net.http_post`.
11. DB TEST đã đánh dấu: hàm JWT ném lỗi, chuông vẫn ghi, ledger có lý do.

### 6.2 TEST environment

- Đồng bộ TEST (`test-env:sync`).
- Tạo đầu ghi fixture trong org TEST, đẩy snapshot giả qua RPC ingest. Contract §2 chỉ cho ghi fixture trên DEMO hoặc TEST.
- Kiểm trọn vòng chuông, push (nếu có thiết bị TEST) và đường dẫn mở tab Camera.

### 6.3 Production

- Áp migration qua lane `migrate:forward`, có biên nhận.
- Bật org thật ở `SHADOW` 48 giờ. Đọc ledger:
  - Không có báo nhầm do 15KV chập chờn.
  - 512TT/15KV/950NK không sinh sự cố giả.
- Chủ bật push trên điện thoại, dùng "Gửi thử". Có thiết bị nhận được thì mới chuyển `LIVE`.
- Sau `LIVE`: chờ sự cố thật đầu tiên, đối chiếu thời điểm với `camera_events`.
- **Không** tắt camera hay rút ổ thật để thử (README: không tự tắt camera đang bảo vệ nhà).

## 7. Phát hành và rollback

**Thứ tự phát hành**
1. Merge PR.
2. Lane `migrate:forward` áp migration T1–T4 với org ở `enabled=false`.
3. `promote:production` cho UI T5.
4. Bật `SHADOW`.
5. Đọc ledger sau 48 giờ.
6. Chuyển `LIVE`.

**Rollback**
- Tắt `enabled`, hoặc unschedule cron.
- UI rollback bằng deployment đã xác minh.
- Không drop bảng, không xoá sự cố đã ghi.

## 8. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Báo nhầm vì chập chờn hoặc UNKNOWN hàng loạt | Ngưỡng §4.2, loại trừ B2, đóng có trễ, chạy SHADOW 48 giờ |
| Không ai nhận được (push chết, Zalo chưa có) | Điều kiện để LIVE ở §4.10; ưu tiên đợt 1b nếu chủ không dùng push |
| Collector chết thì im lặng | C4 bắt dựa vào độ mới của snapshot |
| Lệch #275 | Không tham chiếu hàm chỉ có trên prod. Sau khi #275 merge mới cân nhắc tích hợp giờ yên cá nhân cho WARNING |
| Zalo bị chống spam (Z1) | Gom tin, giới hạn tần suất, chỉ một hội thoại chỉ định |
| Cron đè tải DB prod | Mỗi lượt chỉ đọc vài dòng `camera_recorder_current`. Advisory lock. Ghi ledger theo lô |

## 9. Ước lượng

- Đợt 1: khoảng 2–3 phiên (T1–T4 một phiên, T5 nửa phiên, T6–T7 cộng 48 giờ shadow).
- Đợt 1b: khoảng 1 phiên, sau khi chủ chọn.
- Đợt 2: 1–2 phiên, gồm cả phát hành collector.

## 10. Việc chủ cần làm

1. Duyệt §2, nhất là **Q4 → chọn Z1, Z2 hay Z3**. Nếu chọn Z1 thì chỉ định hội thoại Zalo nhận cảnh báo.
2. Bật thông báo đẩy CRM trên điện thoại (chủ và quản lý các toà), bấm "Gửi thử".
3. Xác nhận danh sách người có quyền xem Trung tâm mạng ở từng toà là đúng người cần nhận cảnh báo.
