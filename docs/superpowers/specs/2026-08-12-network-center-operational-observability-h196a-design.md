# Network Center Operational Observability And H196A Downstream Design

> **[CÒN SỐNG — trạng thái 02/09/2026, CẦN ĐỐI CHIẾU]** Spec ghi "chưa triển khai" nhưng phần H196A đã ship qua `supabase/migrations/20260829010000_network_center_h196a_downstream.sql` (đường khác với 6 migration plan đặt tên). Tài liệu hiện hành: `docs/he-thong/22-network-center.md`.

**Ngày:** 2026-08-12

**Trạng thái:** Đã chốt kiến trúc, chưa triển khai (xem banner — một phần đã ship đường khác)

**Phạm vi kiểm tra:** `https://ptcrm.vercel.app/network-center`, control plane Supabase, Network Center worker, watchdog, thông báo và UI hiện có

## 1. Mục tiêu

Đưa Network Center từ trạng thái có giao diện và scheduler nhưng chưa có coverage vận hành thành một hệ thống có thể trả lời trung thực, theo từng tòa nhà và từng MikroTik:

1. Tòa nào đã được giám sát, tòa nào chưa rollout, tòa nào cấu hình thiếu.
2. Router có thực sự reachable, WAN/default route có hoạt động, địa chỉ quản trị/WAN/public đang được quan sát là gì và bằng chứng còn mới hay không.
3. Khi nào mở, cập nhật, gom nhóm, gửi thông báo và đóng một sự cố mà không gây alert storm.
4. Có thể mô hình hóa một MikroTik gateway và nhiều ZTE ZXHN H196A downstream cùng tòa; trong release này H196A chỉ được quan sát gián tiếp qua evidence do MikroTik đã đọc sẵn.
5. Có log và số liệu lịch sử đủ để phân tích chất lượng mạng theo tòa, theo thiết bị và theo giai đoạn rollout.

Nguyên tắc thứ tự là **operational truth first, H196A indirect-only**. H196A không phải MikroTik con, không phải RouterOS device và không có direct runtime trong release này. Một artifact capability được operator cấp phép có thể phục vụ nghiên cứu phase sau, nhưng không thay đổi `INDIRECT_ONLY` hay tạo credential/connection/assignment.

## 2. Kết quả audit ngày 2026-08-12

### 2.1 Production data plane

Ảnh chụp read-only lúc `2026-08-12T03:47:00Z` cho thấy:

| Chỉ số | Kết quả |
| --- | ---: |
| Tòa thật có `monitoring_enabled=true` | 17 |
| Tòa thật ở rollout `OFF` | 17/17 |
| MikroTik active | 17 |
| Connection được enable | 0 |
| Worker assignment active | 0 |
| Heartbeat còn mới | 0 |
| Current telemetry | 0 |
| Mẫu telemetry 24 giờ | 0 |
| Incident | 0 |
| Rollup/SLA | 0 |
| Outbox delivery | 0 |

Tổ chức DEMO hiện có `0` Network Center settings và `0` MikroTik. Scheduler job đang active, nhưng liveness trả `0 monitoredWorkers / 0 monitoredBuildings`. Maintenance từng lỗi do statement timeout ở thao tác partition/RLS rồi tự phục hồi.

Kết luận: scheduler có chạy, nhưng **coverage giám sát thực tế bằng 0**. UI không được diễn giải trạng thái này là router offline hay hệ thống khỏe.

### 2.2 Production UI/E2E

- PASS: tòa chưa provisioning giữ trạng thái rỗng, không rơi về demo và không tạo lỗi console.
- FAIL: test ngân sách request của DEMO dùng cứng building ID `72dbe01c-2e14-4fac-8b13-d522213a1bf9`, nhưng fixture đó không còn tồn tại.
- Dù fail, test chỉ ghi nhận một fleet RPC và không có console error; đây là fixture drift, không phải request-budget regression.
- Smoke công khai ngày `2026-08-12`: `/network-center` redirect đúng sang `/login`; trang đăng nhập và quên mật khẩu render bình thường, một navigation read-only hoạt động, không có warning/error console hoặc framework overlay. Phiên audit không có authenticated session, nên màn Network Center sau đăng nhập vẫn phải được xác minh bằng headless E2E với account được cấp phép trước rollout.

### 2.3 Khoảng trống đã xác minh trong code

- `infra/network-center-worker/src/routeros/sshConnector.ts` trả `healthStatus: "HEALTHY"` cứng trong `poll()`.
- `healthCheck()` đã tồn tại nhưng polling thông thường không gọi nó.
- Worker chỉ gửi management IP được cấu hình; chưa thu observed WAN IP hoặc public egress IP.
- Polling chỉ phát `ROUTER_UNREACHABLE` và `INVENTORY_DEGRADED`.
- Lần poll fail đầu tiên có thể mở incident ngay; hysteresis hiện chỉ nằm trong RAM process.
- UI ánh xạ unknown/unprovisioned thành offline, thiếu metric/SLA thành `0`, và suy ra WAN up từ management reachability.
- `network_outbox_events` có writer nhưng không có luồng tạo delivery/fanout và không có consumer Network Center.
- Source `network-watchdog` tồn tại và có test, nhưng chưa có deployment lane/readback như `network-center-worker`.
- `network_devices.parent_device_id` đã tồn tại nhưng enum `device_kind` hiện chỉ nhận `MIKROTIK|ARUBA`; H196A chưa có device kind, lifecycle hay connector contract.
- Fleet/building RPC hiện chỉ hiểu một MikroTik gateway cùng Aruba display-only; thêm H196A mà không có model riêng sẽ làm topology/aggregate sai hoặc trộn H196A với RouterOS.

## 3. Phạm vi

### 3.1 In scope

- Coverage state trung thực trên RPC và UI.
- DEMO control-plane canary có dữ liệu do worker thật tạo, không dùng fallback giả.
- Quan sát và lưu lịch sử management/WAN/public IP.
- Health derivation, freshness, incident rule state và hysteresis durable.
- Notification subscription/fanout, in-app notification và optional web push qua hạ tầng hiện có.
- Analytics fleet/building/device phục vụ log tổng hợp và phân tích.
- Một tầng ZTE ZXHN H196A downstream trong cùng tòa, lưu inventory/topology và evidence gián tiếp từ DHCP lease cùng `/ip/neighbor` mà MikroTik đã đọc sẵn.
- Rollout read-only theo đợt và rollback bằng kill switch/rollout state.

### 3.2 Out of scope

- General-purpose multi-vendor framework hoặc direct H196A connector/runtime.
- Arbitrary RouterOS CLI.
- Cây downstream lồng nhiều tầng.
- Dùng MikroTik làm SSH jump host hoặc áp RouterOS CLI/bootstrap cho H196A.
- H196A ở tòa khác với gateway.
- Mở production write/execute cho H196A trong đợt này.
- Ping/DNS reachability test cần mở rộng RouterOS permission `test`.
- Aruba write operations.

## 4. Kiến trúc mục tiêu

```text
Scheduler/Uptime monitor
          |
          v
network-watchdog ---> coverage/liveness/maintenance RPCs
          |
          v
Supabase control plane <--- browser RPCs <--- Network Center UI
          ^
          |
Network Center worker
          |
       WireGuard
          |
          +--> Gateway MikroTik (direct RouterOS SSH)
                    |
                    +--> H196A A (downstream topology; indirect evidence first)
                    +--> H196A B (downstream topology; indirect evidence first)

Operator-authorized lab/DEMO/TEST capture
          |
          +--> offline H196A capability artifact (không nối vào runtime)
```

Worker tiếp tục SSH trực tiếp tới MikroTik qua WireGuard. H196A là ZTE Wi-Fi 5 EasyMesh AP/router downstream, không phải RouterOS device. MikroTik cung cấp evidence gián tiếp như DHCP lease, neighbor/MAC, interface và uplink đã có trong poll; evidence này chỉ chứng minh H196A được nhìn thấy, không chứng minh H196A healthy/offline. Release này không tạo H196A adapter, credential, connection, assignment hay action surface. Nếu operator có capture từ thiết bị lab/DEMO/TEST đã được phép, validator chỉ đọc artifact offline để lưu tri thức cho một plan sau.

## 5. Hợp đồng coverage

Mỗi tòa trả đúng một `coverageState`. Thiếu hẳn dòng `network_site_settings` được phân loại `COVERAGE_MISSING/NO_SITE_SETTINGS`, không bị `coalesce` thành rollout `OFF`:

| State | Điều kiện | Ý nghĩa UI |
| --- | --- | --- |
| `DISABLED` | `monitoring_enabled=false` hoặc thiết bị bị disable có chủ đích | Không giám sát theo quyết định vận hành |
| `NOT_ROLLED_OUT` | rollout `OFF` | Đã khai báo nhưng chưa đưa vào worker |
| `COVERAGE_MISSING` | rollout `READ_ONLY/EXECUTE` nhưng thiếu device, connection, assignment hoặc heartbeat/poll evidence | Lỗi cấu hình coverage; không phải router offline |
| `MONITORED` | Có active gateway, connection pollable, assignment active và evidence trong ngưỡng freshness | Có đủ cơ sở để đánh giá health |

`coverageReason` là mã ổn định, gồm `NO_SITE_SETTINGS`, `MONITORING_DISABLED`, `ROLLOUT_OFF`, `NO_GATEWAY`, `NO_CONNECTION`, `NO_ASSIGNMENT`, `WORKER_STALE`, `POLL_NEVER_OBSERVED`. Fleet RPC trả count theo bốn state; watchdog có thể đặt minimum expected coverage theo từng rollout wave.

Coverage và health là hai trục khác nhau. Chỉ `MONITORED` mới được góp vào healthy/degraded/critical/offline và SLA.

## 6. Hợp đồng IP evidence

### 6.1 Loại evidence

| Kind | Nguồn | Ý nghĩa |
| --- | --- | --- |
| `MANAGEMENT` | `network_device_connections.management_ip` và SSH target đã verify | IP worker dùng để quản trị router |
| `WAN` | RouterOS interface/address và default-route evidence | Địa chỉ đang gắn trên uplink/WAN của router |
| `PUBLIC_EGRESS` | Giá trị read-only `public-address` từ `/ip/cloud/print detail without-paging`, nếu router đã có sẵn | Public IP do RouterOS quan sát mà không kích hoạt network test |

Mỗi evidence gồm `device_id`, `kind`, `address`, `source`, `confidence`, `interface_key`, `observed_at`, `expires_at`, `details` đã redact. Current projection lưu bản mới nhất; append-only history giữ thay đổi để phân tích IP churn.

`confidence` dùng `CONFIGURED`, `OBSERVED`, `VERIFIED`. Management IP cấu hình nhưng chưa SSH được chỉ là `CONFIGURED`; WAN và `public-address` đọc từ router là `OBSERVED`. `VERIFIED` chỉ dành cho bằng chứng đã có readback độc lập trong một phase sau; đợt này không tự bật IP Cloud, không `force-update`, không dùng `/tool/fetch` và không gọi endpoint bên ngoài từ router.

### 6.2 DNS

Worker đọc DNS configuration từ `/ip/dns/print detail without-paging`. Đây là **cấu hình DNS**, không chứng minh phân giải thành công. Không gọi ping hoặc RouterOS `/tool` test vì principal hiện không có permission `test` và đợt này không mở rộng permission.

## 7. Health và freshness

Database persist một trong:

- `UNKNOWN`: chưa đủ evidence hoặc evidence hết hạn.
- `HEALTHY`: management reachable, WAN/default route hợp lệ, DNS configured, evidence bắt buộc còn mới và resource không vượt ngưỡng.
- `DEGRADED`: telemetry stale, DNS config/public IP thiếu, IP thay đổi, inventory lỗi hoặc CPU/RAM/temperature vượt ngưỡng.
- `CRITICAL`: management còn reachable nhưng WAN/default route thất bại.
- `OFFLINE`: management không reachable sau hysteresis.

UI hiển thị `UNKNOWN` bằng nhãn **Chưa có dữ liệu (`NO_DATA`)**, không đổi giá trị persist thành `NO_DATA`. Không dùng `0` làm thay thế cho CPU, RAM, throughput, uptime hoặc MTTR chưa được đo. WAN có `UP`, `DOWN`, `UNKNOWN`, độc lập với management reachability.

Freshness mặc định dựa trên `poll_interval_seconds`: evidence bắt buộc stale sau `max(3 * poll interval, 180 seconds)`. Ngưỡng cụ thể được lưu cùng rule version để lịch sử có thể giải thích.

## 8. Incident, hysteresis và dependency

### 8.1 Durable rule state

`network_incident_rule_state` lưu theo `(device_id, rule_key)`:

- consecutive failures/successes;
- first/last failure và last success;
- current state `CLOSED`, `PENDING_OPEN`, `OPEN`, `PENDING_RECOVERY`;
- active incident ID và fingerprint;
- rule version và last evidence time.

Mặc định mở sau **3 lần fail liên tiếp**, phục hồi sau **2 lần success liên tiếp**. State được cập nhật trong database cùng ingest/evaluation để restart worker không làm mất hysteresis.

### 8.2 Rule catalog

Các rule bắt buộc:

- `MANAGEMENT_UNREACHABLE` -> `ROUTER_UNREACHABLE`, critical.
- `WAN_DEFAULT_ROUTE_DOWN` -> `WAN_DOWN`, critical.
- `TELEMETRY_STALE` -> warning.
- `PUBLIC_IP_MISSING` và `PUBLIC_IP_CHANGED` -> warning.
- `DNS_CONFIG_MISSING` -> warning.
- `RESOURCE_PRESSURE` -> warning/critical theo ngưỡng.
- `INVENTORY_DEGRADED` -> warning, không làm router offline.
- `COVERAGE_MISSING` -> operator/control-plane incident, không tính downtime router.

Fingerprint ổn định theo `organization/building/device/rule`, không chứa observation timestamp. Observation mới refresh incident hiện có thay vì tạo incident mới.

### 8.3 Gateway và H196A downstream

Nếu MikroTik gateway mở incident `ROUTER_UNREACHABLE`, các H196A downstream chuyển sang `DEPENDENCY_UNKNOWN`; không tự mở một critical outage H196A chỉ vì mất đường quan sát qua gateway. Notification gửi một root-cause message gồm danh sách H196A bị ảnh hưởng. H196A trong release này chỉ có `SEEN|STALE|DEPENDENCY_UNKNOWN|NO_DATA`, không suy diễn `HEALTHY/OFFLINE`.

### 8.4 Maintenance

Maintenance không xóa hoặc ngừng thu evidence. Nó chỉ:

- suppress notification escalation;
- loại thời gian khỏi SLA eligible seconds;
- gắn `suppressedByMaintenance=true` vào incident observation.

Incident vẫn có thể mở/refresh để bảo toàn lịch sử kỹ thuật.

## 9. SLA và analytics

`network_sla_daily` hiện có khóa chính cấp building `(organization_id, building_id, sla_day)`, nên vẫn là rollup chính của tòa và mở rộng thêm:

- `unknown_seconds`;
- `coverage_seconds`;
- `coverage_pct`;
- breakdown healthy/degraded/critical/offline;
- không thêm `device_id` vào bảng này vì sẽ phá khóa/consumer hiện có; rollup per-device đi vào bảng mới `network_device_sla_daily` với khóa `(organization_id, building_id, device_id, sla_day)`.

`UNKNOWN` không bao giờ tính là uptime. `uptime_pct` chỉ có giá trị khi `coverage_seconds > 0`; nếu không, RPC trả `null`.

Analytics RPCs:

- `network_center_get_operational_summary_v1(p_from, p_to)` trả coverage, health, incident, IP change, stale evidence và notification delivery theo fleet.
- `network_center_get_building_analysis_v1(p_building_id, p_from, p_to)` trả timeline theo device, outage root cause, SLA/coverage, WAN/public IP change và resource pressure.
- `network_center_list_device_events_v1(p_building_id uuid, p_device_id uuid DEFAULT NULL, p_event_kinds text[] DEFAULT NULL, p_severities text[] DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_before_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 100)` dùng keyset cursor `(occurred_at, id)` cho log phân tích chi tiết, mặc định 24 giờ, tối đa 90 ngày và 250 dòng/trang.

RPC event trả `{ items, nextCursor }`; mỗi item có ID/timestamp/building/device/event kind/severity/health/incident/source/summary và `details` qua allowlist redact. Không dùng `OFFSET`. `p_device_id` phải thuộc đúng building được phép; filter lạ, filter quá 16 phần tử, chỉ có một đầu time range hoặc cursor không hợp lệ đều fail closed.

Mọi SECURITY DEFINER browser read lọc bằng helper access building có thẩm quyền; không dựa vào RLS implicit hoặc nhánh super-admin tự viết.

## 10. Notification delivery

### 10.1 Subscription

Không mở rộng `notification_preferences` vì bảng đó chỉ nhận event family `E1`–`E5`. Tạo `network_notification_subscriptions` scoped theo:

- user, organization, optional building;
- minimum severity;
- `in_app`, `push`;
- quiet hours/timezone;
- enabled và version.

RLS own-row kết hợp restrictive sandbox-hide policy. Recipient phải còn active membership và có quyền `network_center.view` trên building tại thời điểm fanout.

### 10.2 Fanout

Khi incident open/escalate/recover hoặc coverage gap thay đổi, transaction ghi `network_outbox_events`. Schema hiện tại của `network_outbox_deliveries` chỉ unique theo `(outbox_event_id, channel)` và chưa có recipient, nên forward migration phải thêm nullable `recipient_id` tham chiếu `auth.users(id)`, giữ row legacy ở `NULL`, rồi dùng hai partial unique index: `(outbox_event_id, channel) WHERE recipient_id IS NULL` và `(outbox_event_id, recipient_id, channel) WHERE recipient_id IS NOT NULL`. Watchdog maintenance/fanout job sau đó tạo delivery recipient-deduped và insert `notifications`:

- `status='PENDING'` chỉ là unread/read axis; không dùng làm delivery state.
- `channel='IN_APP'`.
- dùng notification `type='CUSTOM'` hoặc type hiện có tương thích; không thêm enum chỉ cho Network Center.
- metadata chứa `domain='NETWORK_CENTER'`, organization/building/device/incident ID, severity, event kind, fingerprint và deep link.
- `push_state='QUEUED'` chỉ khi subscription bật push; nếu không để `NULL`.

Push tiếp tục dùng drain hiện có. Delivery status của Network Center nằm ở `network_outbox_deliveries`, độc lập với `notifications.status` và `push_state`.

Quiet hours không trì hoãn in-app history: notification in-app vẫn được tạo ngay. Với recipient bật push, fanout đặt `push_state=NULL` trong giờ yên và ghi `metadata.pushDeferredUntil`; một watchdog sweep sau giờ yên chuyển đúng dòng đó sang `QUEUED`. Critical recovery cũng được tạo ngay theo cùng quy tắc. Dedupe dựa trên `(outbox_event_id, recipient_id, channel)`.

## 11. H196A downstream model

### 11.1 Invariant

- Mỗi building có đúng tối đa một active MikroTik gateway: `parent_device_id IS NULL`.
- Có thể có nhiều active `ZTE_H196A`: `parent_device_id = gateway.id`.
- Parent của H196A phải là active MikroTik cùng organization/building và phải là root.
- H196A không được có child; depth lớn hơn một bị trigger từ chối.
- Aruba vẫn là display-only device và không dùng parent relationship này làm đường điều khiển.

Thêm `ZTE_H196A` vào device kind và giữ unique index MikroTik hiện tại làm invariant đúng một gateway. Không nới index để tạo thêm MikroTik. Stable identity H196A chỉ nhận serial đã chuẩn hóa hoặc globally administered unicast MAC; loại MAC locally administered/randomized, multicast, zero và broadcast. Với MAC text chuẩn `xx:xx:xx:xx:xx:xx`, second nibble của octet đầu phải thuộc `[048c]`. Một external key không được đại diện hai thiết bị.

### 11.2 Provisioning

Admin RPC `network_center_admin_register_h196a_v1(p_gateway_device_id uuid, p_stable_key text, p_display_name text, p_serial_number text DEFAULT NULL, p_mac_address macaddr DEFAULT NULL, p_observed_ip inet DEFAULT NULL, p_firmware_version text DEFAULT NULL, p_discovery_evidence jsonb DEFAULT '{}'::jsonb, p_request_id uuid DEFAULT gen_random_uuid())` nhận gateway ID, stable identity, display name, optional observed IP, firmware/version và discovery evidence. RPC không nhận capability verdict; transaction luôn ghi `capability_verdict='INDIRECT_ONLY'`, `monitoring_mode='INDIRECT'`, `write_capability=false` và không tạo worker connection/credential/assignment.

Stable key chỉ nhận `serial:<normalized>` hoặc `mac:<lowercase-globally-administered-unicast-mac>`. DHCP hostname, neighbor identity hay IP chỉ là evidence ghép nối có `observed_at`/`expires_at`, không phải management address authoritative và không đủ tự động tạo thiết bị. Observation đã match thiết bị đăng ký phải mang stable identity. Candidate/quarantine chưa match mang `proposedStableKey` nullable, evidence fingerprint và reason; hostname/IP-only bắt buộc ở candidate/quarantine. Unknown/ambiguous/conflicting candidates không được ghi đè stable identity đã đăng ký. Worker tái sử dụng hai read đã có là DHCP lease và `/ip/neighbor`, không phát thêm RouterOS command để tìm H196A.

Capability discovery không phải network command hay scanner. Operator chỉ cung cấp một capture đã được phép từ thiết bị lab/DEMO/TEST; validator offline kiểm schema, model, firmware, stable identity match, protocol evidence, `writeAttempted=false` và redaction. Validator không kết nối tới H196A, không brute-force, không bật management, không đổi password, không upload firmware, không reboot và không liên hệ ACS của ISP. Artifact có verdict nghiên cứu `INDIRECT_ONLY`, `DIRECT_READ_ONLY_VERIFIED` hoặc `UNSUPPORTED`, nhưng UI/runtime release này không hiển thị direct state và luôn giữ H196A `INDIRECT_ONLY`. Muốn dùng direct evidence phải có design/plan riêng khóa exact firmware, protocol, transport, ownership và credential lifecycle.

Không tái sử dụng `generate-router-bootstrap.mjs`, `WORKER_GROUP_POLICIES` hoặc RouterOS command surface cho H196A. Nếu firmware thực tế chỉ hỗ trợ TR-069 qua ACS của ISP mà dự án không sở hữu/control ACS, verdict bắt buộc là `INDIRECT_ONLY`; plan không tìm cách bypass ISP management.

### 11.3 Worker/API/UI

`network_center_worker_list_connections_v2` tiếp tục chỉ trả connection MikroTik pollable. H196A không được thêm vào RouterOS connection list trong plan này. Inventory payload v2 được mở rộng bằng matched `h196a[]` và candidate `h196aQuarantine[]`, dựa trên DHCP lease và neighbor record đã đọc sẵn; response trả mapping stable key -> H196A device ID cho matched observation. Không có H196A adapter boundary trong runtime.

Fleet summary chỉ aggregate MikroTik gateway làm trạng thái chính, đồng thời trả `h196aCount`, `h196aIndirectSeen`, `h196aProblemCount`. Building RPC trả `downstreamDevices[]`, `gatewayDeviceId` và selected device detail. RPC event/analytics nhận optional `p_device_id` và validate device thuộc building được phép.

UI hiển thị cây `MikroTik -> H196A`, badge nguồn evidence `Gián tiếp qua DHCP` hoặc `Gián tiếp qua Neighbor`, observed IP cùng freshness, và trạng thái `SEEN|STALE|DEPENDENCY_UNKNOWN|NO_DATA`. Không hiển thị direct badge, credential hay action controls trên H196A. Contract vẫn thêm `deviceId` tường minh cho read/query/audit target để chọn H196A không bị retarget về gateway; mutation/action schema từ chối `deviceKind='ZTE_H196A'` trong scope này.

## 12. Watchdog và deployment

`network-watchdog` cần lane deploy riêng với cùng tiêu chuẩn release hiện có:

- source bundle digest/SHA trong manifest;
- deploy exact function name và `--no-verify-jwt` chỉ khi contract secret header yêu cầu;
- evidence store ghi exact reviewed source digest cùng version từ deploy response; Management API list readback xác nhận function `ACTIVE`, exact version và `verify_jwt` đang chạy. Nếu API không công bố server-side digest thì báo rõ digest chỉ được bind qua immutable deploy receipt, không giả thành independent readback;
- smoke wrong/missing secret -> 401, healthy DEMO -> 200, coverage missing/stale -> 503;
- rollback redeploy exact previous digest.

Watchdog bổ sung route/job `fanout` hoặc đưa fanout vào maintenance có bounded batch, advisory lock và receipt rõ ràng. Uptime monitor vẫn là kênh độc lập để phát hiện watchdog/control-plane chết.

## 13. Rollout

1. **Implement và prove offline:** coverage, canary CLI, health/IP, durable incident, notification, analytics và H196A đều phải có focused test cùng disposable PostgreSQL proof; chưa tạo connection trên môi trường dùng chung.
2. **Freeze release:** commit reviewed source/provenance, sinh manifest pin sáu migration cùng hai Edge bundle, rồi chạy toàn bộ static/runtime gate từ clean SHA.
3. **Apply schema:** dry-run rồi apply từng migration qua lane `migrate:forward`, mỗi file có backup/receipt riêng; sau cả sáu file mới sinh project-backed types và catalog evidence.
4. **Deploy runtime:** deploy exact Edge bundles và worker candidate, rồi read back database function bodies, Edge ACTIVE version/verify-JWT, worker image/heartbeat và emergency-stop contract.
5. **DEMO/TEST canary:** tạo gateway DEMO, connection, worker assignment; yêu cầu tối thiểu bảy vòng poll read-only xanh, kiểm health/IP/analytics, đăng ký H196A ở `INDIRECT` và xác minh topology/evidence.
6. **Controlled dependency exercise:** chỉ trên DEMO/TEST, chặn route từ worker tới gateway trong ba poll rồi phục hồi hai poll để chứng minh hysteresis, root-cause grouping, notification dedupe và H196A `DEPENDENCY_UNKNOWN`; không gửi synthetic observation qua browser/admin RPC.
7. **Real canary:** một tòa thật `READ_ONLY` trong 24 giờ, sau đó batch ba tòa, rồi các tòa còn lại. Không bật `EXECUTE` trong scope này.

Stop condition cho mỗi wave: coverage thiếu ngoài dự kiến, stale heartbeat, unexpected write, notification duplicate, SLA/unknown sai, worker capacity vượt gate hoặc UI phát sinh console/network regression.

## 14. Rollback

- Hạ building về `OFF` để rút khỏi coverage mà không xóa evidence.
- `changes_paused=true` và `EMERGENCY_STOP=true` chỉ đóng băng ghi; muốn dừng toàn bộ SSH polling phải stop service/container.
- Disable H196A inventory row nếu cần dừng hiển thị; không có direct credential/assignment để revoke trong release này, và vẫn giữ topology/evidence/incident history.
- Watchdog rollback về exact previous function digest.
- Frontend có thể rollback revision độc lập; additive schema được giữ và sửa bằng forward migration, không xóa lịch sử.
- Notification fanout có kill switch; push queue có thể dừng trong khi in-app/outbox evidence vẫn giữ.

## 15. Verification contract

- Static/migration tests cho schema, index, trigger, ACL, RLS, sandbox-hide và exact RPC signature.
- Disposable PostgreSQL 17.6 proofs cho coverage state, durable hysteresis, SLA unknown, fanout dedupe, tenant isolation và H196A parent/depth invariant.
- Worker unit tests cho health derivation, IP parsing, public-address absence/redaction, dependency suppression và restart-resilient behavior.
- Deno 2.9.4 tests cho worker Edge và watchdog routes/deploy contract.
- Frontend Vitest cho `UNKNOWN/NO_DATA`, nullable metric/SLA, gateway filtering, H196A selector/source badge và exact device targets.
- Headless Playwright cho DEMO canary, request budget, live no-fallback, H196A selection và notification deep link.
- Production readback là read-only cho org thật cho tới wave real canary được phê duyệt trong task triển khai.

## 16. Definition of Done

Thiết kế được coi là triển khai xong khi:

- Không tòa nào bị gọi offline chỉ vì chưa rollout hoặc thiếu coverage.
- DEMO có poll evidence thật và watchdog không còn khỏe giả với zero monitored fleet sau khi minimum coverage bật.
- Management/WAN/public IP có source, confidence, freshness và history.
- Health/incident tuân thủ semantics và hysteresis durable; restart không tạo alert mới sai.
- Network Center event tạo được in-app notification và optional push đúng subscription, không lạm dụng unread status.
- Dashboard/fleet analytics phân biệt downtime với unknown và coverage gap.
- Một MikroTik gateway + ít nhất một H196A DEMO/TEST hiển thị đúng topology và evidence source; H196A luôn `INDIRECT_ONLY`, không có connection/credential/assignment/action và không bị gọi healthy/offline từ lease/neighbor evidence.
- Các gate bắt buộc, disposable DB proofs, worker/Edge tests, build và E2E liên quan đều xanh trước rollout production.
