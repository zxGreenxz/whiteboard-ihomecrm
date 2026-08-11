# Audit realtime toàn hệ thống và kế hoạch tối ưu

> Ngày audit: 2026-07-29
>
> Phạm vi: React/TypeScript, TanStack Query cache, Supabase Realtime, Postgres/RLS, migrations và các flow nghiệp vụ liên quan
>
> Production đối chiếu: <https://ptcrm.vercel.app>
>
> Trạng thái: tài liệu audit và đề xuất kiến trúc; chưa triển khai thay đổi code hoặc database

> ## ⛔ Phạm vi đã THU HẸP — 2026-08-11
>
> **Ba tiểu hệ nằm NGOÀI kế hoạch này: Network Center (`network_*`), OpenClaw
> (`openclaw_*`) và Zalo (`zalo_*`).** Mỗi cái có vòng đời và cửa kiểm riêng; gộp
> chúng vào một kế hoạch realtime của CRM nghiệp vụ chỉ tạo ra đề xuất mà người thi
> hành không có thẩm quyền — hoặc tệ hơn, có thẩm quyền mà không có ngữ cảnh.
>
> **Phạm vi còn lại**: 7 bảng nghiệp vụ trong publication (`buildings`, `contracts`,
> `customers`, `income_expenses`, `invoices`, `jobs`, `rooms`) cộng các bảng tiền và
> vòng đời đã nối vào hub từ 29/07, `notifications`, và hub realtime trung tâm.
>
> Các mục đã bị gỡ, ghi lại ở đây để việc cắt không im lặng:
>
> | Mục | Nội dung cũ | Vì sao gỡ |
> |---|---|---|
> | §15.4 ★★★2 | "5 bảng `network_*` publish nhưng 0 consumer — quick win DROP" | Đề xuất này **đã sai** từ khi Network Center ship (`vercel.json` đặt `VITE_NETWORK_CENTER_MODE=production`, `useNetworkCenter.ts` subscribe đủ 5 bảng). Thi hành sẽ phá một tính năng đang chạy. Gỡ cả đề xuất lẫn phần đính chính nó. |
> | §15.6 mục 5 | "DROP 5 bảng `network_*` khỏi publication" | như trên |
> | §16.5 | Bảng chi tiết 6 RPC `openclaw_*` chiếm ~85% thời gian DB | Giữ **kết luận** (query list của CRM chỉ chạm ~0,6% tải DB), bỏ **chủ thể** nằm ngoài phạm vi. |
> | §15.4 #13 · §16.2 · §16.6 | Các channel `zalo_*` trong danh sách "phải gắn callback trạng thái" | Zalo ra khỏi phạm vi 11/08. Số channel phải xử ở Giai đoạn 5 giảm từ 4 xuống **2** (hub + notifications). |
> | §4.1 · §15.4 #9 | `zalo_*` trong bảng phân loại publication và bảng xếp hạng tải DB | như trên — giữ số đo, bỏ hạng mục |
>
> Chữ "network" ở nghĩa thông thường (network waterfall, network load, số request)
> **không** thuộc diện này và được giữ nguyên.

## 1. Kết luận điều hành

Nhận định về flow tạo khách ngay trong màn hình lập hợp đồng là đúng: khách mới phải xuất hiện và được chọn gần như tức thì. Realtime chỉ nên đồng bộ thay đổi sang tab hoặc thiết bị khác; không nên bắt chính thao tác vừa tạo phải đi vòng qua invalidate cache, tải lại toàn bộ danh sách rồi chờ realtime.

Kiến trúc hiện tại thực chất đang chạy theo chuỗi:

```text
Mutation
  → invalidate cache
  → tải lại toàn bộ danh sách
  → enrichment dữ liệu liên quan
  → render
  → nhận event realtime của chính client vừa ghi
  → tải lại thêm một lần nữa
```

Đây là nguyên nhân trực tiếp gây độ trễ hơn 2 giây ở flow tạo khách từ hợp đồng. Đây cũng là một mẫu kiến trúc phổ biến trong codebase, không phải lỗi riêng của một dialog.

Kiến trúc mục tiêu nên là **hybrid local-first**:

1. Mutation trả về entity canonical từ server.
2. Client vừa thao tác cập nhật state/cache ngay lập tức.
3. Reconciliation chạy nền và không chặn UI.
4. Realtime dùng để đồng bộ sang tab/client khác.
5. Event được xử lý theo dependency/domain registry có type, không hard-code query key rời rạc.
6. Các list nặng dùng read model gọn, cursor pagination và lazy-load detail.

## 2. Phạm vi và phương pháp audit

Audit đã bao phủ:

- 812 file TypeScript/TSX production.
- React Query queries, mutations, invalidation và direct cache update.
- Realtime hub trung tâm và các realtime hook riêng.
- Supabase publication đang tồn tại trên production.
- Các bảng được frontend mutation trực tiếp.
- Query shape của customers, contracts, invoices và vehicles.
- `pg_stat_statements` và `EXPLAIN (ANALYZE, BUFFERS)`.
- RLS helper tham gia vào customer picker và realtime authorization.
- Flow production headless tạo khách từ màn hình hợp đồng.
- Console errors, network waterfall và cleanup dữ liệu test DEMO.
- Migration drift giữa catalog production và `schema_migrations`.

Thống kê tĩnh toàn codebase:

| Hạng mục | Số lượng |
|---|---:|
| `useQuery`/`useInfiniteQuery` | 301 |
| `useMutation` | 279 |
| `invalidateQueries` | 536 |
| `setQueryData`/`setQueriesData` | 9 |
| Literal query-key roots | 196 |
| Direct database/storage sources | 98 |
| Bảng có mutation trực tiếp | 59 |
| Bảng mutation chưa nằm trong publication | 52 |

Con số 52 không đồng nghĩa phải publish realtime cả 52 bảng. Nó cho thấy hệ thống đang phụ thuộc rất mạnh vào `invalidate → refetch`, trong khi bản đồ dependency và tín hiệu thay đổi chưa đủ để bảo đảm cache luôn đúng.

## 3. Case study: tạo khách mới từ màn hình hợp đồng

### 3.1. Bằng chứng production

| Hạng mục | Kết quả |
|---|---:|
| Khách active tại org thật | 501 |
| Thời gian mở customer picker | 1.721 ms |
| Request khi mở picker | 8 request nối tiếp |
| Tạo khách tại DEMO, warm run | 943 ms mới thấy dòng |
| Các lần gồm scroll/action automation | 1.768–1.918 ms |
| POST tạo customer | 171 ms |
| Refetch danh sách customers | 361 ms |
| Enrichment hợp đồng/phòng | 247 ms |
| Duplicate refetch do realtime echo | Bắt đầu khoảng 1.448 ms |

Khi mở picker ở org thật có 501 khách, network waterfall gồm:

1. Một GET `customers`, khoảng 243 ms.
2. Bảy GET `contract_customers` nối tiếp, mỗi request khoảng 146–183 ms.
3. Render 501 hàng.

Sau khi tạo khách:

1. POST tạo customer mất khoảng 171 ms.
2. Mutation trả về customer canonical.
3. Response này không được dùng để cập nhật picker.
4. Cache `customers` bị invalidate.
5. Client tải lại toàn bộ customers.
6. Client tiếp tục enrichment theo các chunk tuần tự.
7. Dòng mới xuất hiện sau khoảng 938–943 ms ở warm run.
8. Event realtime từ chính INSERT đó đến sau debounce 800 ms và kích hoạt thêm một vòng refetch nền.

Điều này giải thích trực tiếp quan sát “hơn 2 giây” trên org thật: thời gian không nằm chủ yếu ở câu INSERT, mà nằm ở việc tải lại toàn bộ tập dữ liệu, N+1 theo chunk và duplicate realtime echo.

### 3.2. Bằng chứng trong code

- Picker dùng toàn bộ `useCustomers` tại [`src/components/contracts/CustomerSelectionDialog.tsx`](../../src/components/contracts/CustomerSelectionDialog.tsx), thay vì một query picker gọn.
- `CreateCustomerDialog` chỉ nhận `open` và `onOpenChange`; không có callback `onCreated(customer)` tại [`src/components/customers/CreateCustomerDialog.tsx`](../../src/components/customers/CreateCustomerDialog.tsx).
- Query customers dùng `select("*", { count: "exact" })` tại [`src/hooks/useCustomers.ts`](../../src/hooks/useCustomers.ts).
- Sau query chính, enrichment `contract_customers → contracts → rooms → buildings` chạy theo chunk 80 bằng vòng `for` tuần tự.
- Mutation đã trả về customer canonical nhưng `onSuccess` bỏ qua `data`, chỉ invalidate `customers`, `customer-stats` và `vehicles`.

### 3.3. Root cause

Root cause không phải “Supabase realtime chậm”. Root cause là đường ghi và đường hiển thị của chính client bị thiết kế vòng:

```text
Server đã trả customer mới
  → frontend bỏ qua customer đó
  → yêu cầu server đọc lại toàn bộ danh sách
  → enrich toàn bộ danh sách
  → realtime của chính client lại yêu cầu đọc thêm lần nữa
```

Cùng một tab không cần realtime để biết dữ liệu do chính nó vừa tạo.

## 4. Đánh giá realtime hiện tại

### 4.1. Publication production

Production hiện có 16 bảng trong publication realtime, trong đó **thuộc phạm vi kế
hoạch này** là 7 bảng:

- Business: `buildings`, `contracts`, `customers`, `income_expenses`, `invoices`, `jobs`, `rooms`.

Chín bảng còn lại thuộc Zalo (4) và Network Center (5) — **ngoài phạm vi**, xem banner
đầu tài liệu. Chúng vẫn được đếm ở đây vì mọi bảng trong publication đều cộng vào chi
phí WAL poller (§16.4 ✗1), nhưng không sinh ra hạng mục nào trong kế hoạch.

Tất cả đang dùng replica identity mặc định.

### 4.2. Hub realtime trung tâm

Hub tại [`src/hooks/useRealtimeDataSync.ts`](../../src/hooks/useRealtimeDataSync.ts) đang:

- Subscribe Postgres Changes theo bảng.
- Dùng event như tín hiệu invalidate, không tin payload.
- Debounce 800 ms theo bảng.
- Hard-code danh sách query keys chịu ảnh hưởng.
- Luôn gọi `prefetchDomain` khi tab visible và entry có domain.
- Không đăng ký callback theo dõi trạng thái subscription.

Đây là nền tảng có chủ đích tốt nhưng đang có bốn vấn đề kiến trúc:

1. Dependency mapping thủ công nên dễ bỏ sót.
2. Không phân biệt event của chính client với event từ client khác.
3. Không phân biệt query đang active với query chỉ nằm trong cache.
4. Không có health/reconnect/catch-up protocol.

### 4.3. Các lỗ hổng dependency đã xác định

- `rooms` và `buildings` đã publish nhưng hub chỉ invalidate `business-performance`, không invalidate chính cache `rooms` hoặc `buildings`.
- Customer đổi tên không làm mới các customer embeds trong contracts, invoices hoặc vehicles.
- `contract_customers`, `contract_services`, `vehicles`, `payments`, `invoice_items`, `meters`, `meter_readings`, `contract_terminations` chưa phát tín hiệu domain đầy đủ.
- `useSyncContractCustomers` hard-delete rồi insert các junction rows nhưng không tạo parent contract event. Client khác có thể giữ customer list của contract cũ.
- Event invoice chưa chắc phản ánh các thay đổi chỉ xảy ra ở `invoice_items` hoặc `payments`.
- Aggregate/dashboard query có query-key root khác dễ bị sót nếu người phát triển quên sửa hub.

### 4.4. Hard-delete junction tables

Không nên bật Postgres Changes một cách cơ học cho mọi junction table hard-delete vì:

- Supabase không hỗ trợ filter DELETE như INSERT/UPDATE.
- Payload DELETE và RLS có giới hạn riêng.
- Fan-out theo table dễ đánh thức client không liên quan.
- Junction changes thường có ý nghĩa ở cấp parent/domain, không phải cấp row độc lập.

Các phương án phù hợp hơn:

- Transaction “touch” parent contract/invoice.
- Tăng `domain_version` theo organization.
- Phát private Database Broadcast theo topic domain/org.

### 4.5. Realtime echo và eager prefetch

Sau mutation local:

1. Mutation `onSuccess` invalidate cache.
2. Postgres Changes gửi lại event cho cùng client.
3. Hub debounce 800 ms.
4. Hub invalidate thêm lần nữa.
5. Nếu tab visible, hub còn `prefetchDomain` bất kể user có đang ở trang đó hay không.

Với invoices/contracts vốn là query nặng, cách này tạo network và database load nền không cần thiết.

### 4.6. Health và reconnect

`channel.subscribe()` hiện không xử lý:

- `SUBSCRIBED`.
- `CHANNEL_ERROR`.
- `TIMED_OUT`.
- `CLOSED`.

Global React Query config lại tắt `refetchOnWindowFocus`. Vì vậy khi tab ngủ, mất mạng hoặc websocket gián đoạn, client không có version check hoặc catch-up refetch đáng tin cậy. Cache có thể cũ mà UI không biết.

### 4.7. Notifications realtime đang là WIP

- Hook `useNotificationsRealtime` và component `NotificationsRealtime` đã xuất hiện trong worktree tại [`src/hooks/useNotifications.ts`](../../src/hooks/useNotifications.ts).
- [`src/App.tsx`](../../src/App.tsx) mới mount `RealtimeDataSync`, chưa mount `NotificationsRealtime`.
- Migration publication notifications chưa apply production.

Vì vậy notifications realtime chưa thể tính là production-ready.

## 5. Đánh giá database và hiệu năng query

### 5.1. `pg_stat_statements`

Statistics được ghi nhận từ lần reset ngày 2026-04-25.

| Query shape | Mean execution |
|---|---:|
| Invoice list và nested relations | 0,8–2,2 giây |
| Contract list | 0,85–1,36 giây |
| Customer search | 0,73–1,64 giây |
| Customer picker list | 0,17–0,46 giây |
| Vehicle list | khoảng 435 ms |
| Customer enrichment `contract_customers` | khoảng 98 ms/chunk |

Các query chính đang có shape nặng:

- Invoice list dùng `select *`, contract customers, toàn bộ items/payments và RPC bổ sung.
- Contract list dùng `select *` và nhiều lateral embed.
- Vehicle list dùng `select *` và embeds.
- Customer search dùng `%ILIKE%` trong khi index hiện tại là GIN `to_tsvector`; index không khớp query thực tế.

Phần lớn shared blocks là cache hit, gần như không đọc disk. Nút thắt thiên về:

- RLS.
- Lateral joins.
- CPU.
- Exact count.
- Số round-trip.
- Tải dữ liệu rộng hơn nhu cầu UI.

### 5.2. `EXPLAIN ANALYZE` customer picker

Khi chạy với JWT DEMO:

- Tổng database execution khoảng 11,2 ms.
- 1.537 shared hit blocks.
- Initplan `can_access_org_entity` khoảng 8,8 ms.
- Riêng initplan này dùng 1.399 shared hit blocks.

Điều này cho thấy:

1. Case picker không chậm vì scan 501 customer rows ở database.
2. Độ trễ end-to-end chủ yếu đến từ frontend/network waterfall.
3. RLS helper vẫn chiếm phần lớn chi phí DB của query và sẽ trở thành vấn đề khi bị nhân theo số event × subscriber.

Helper `can_access_org_entity` gọi `app_private.has_any_scope_v3`, bao gồm chuỗi join/deny-wins phức tạp. Supabase Postgres Changes authorize từng event cho từng subscriber và xử lý thay đổi theo thứ tự trên một thread, nên RLS đắt còn ảnh hưởng trực tiếp đến realtime throughput.

Tham khảo chính thức: [Supabase Postgres Changes — scaling](https://supabase.com/docs/guides/realtime/postgres-changes#scaling-postgres-changes).

### 5.3. Catalog drift

- Production có `rooms` và `buildings` trong publication.
- Migration [`supabase/migrations/20260726030000_business_performance_realtime_sources.sql`](../../supabase/migrations/20260726030000_business_performance_realtime_sources.sql) chưa xuất hiện trong `schema_migrations` production tại thời điểm audit.
- Migration [`supabase/migrations/20260729180000_notifications_realtime_publication.sql`](../../supabase/migrations/20260729180000_notifications_realtime_publication.sql) chưa apply production.

Đây là dấu hiệu catalog production và lịch sử migration không hoàn toàn đồng bộ. Cần xử lý trước khi mở rộng publication để tránh môi trường mới và production có schema khác nhau.

## 6. Findings theo mức độ ưu tiên

### Critical — Cùng client phải refetch toàn bộ sau mutation

- **Tác động:** UI chậm, request thừa, tải tăng theo quy mô dữ liệu.
- **Bằng chứng:** flow tạo khách mất 943–1.918 ms dù POST chỉ 171 ms.
- **Root cause:** mutation response không được đưa vào cache/state.
- **Hướng sửa:** local-first mutation response, auto-select và background reconciliation.

### Critical — Dependency graph realtime không đầy đủ

- **Tác động:** client khác có thể giữ dữ liệu cũ ở contracts, invoices, vehicles, rooms/buildings và junction-dependent screens.
- **Root cause:** query-key mapping hard-code theo bảng.
- **Hướng sửa:** typed dependency/domain registry và parent/domain signals.

### High — Không có reconnect/catch-up protocol

- **Tác động:** tab ngủ hoặc websocket lỗi có thể giữ cache stale vô thời hạn.
- **Root cause:** không theo dõi channel status, không version check, `refetchOnWindowFocus` bị tắt.
- **Hướng sửa:** health state, reconnect handling và catch-up active queries/domain version.

### High — Same-client realtime echo gây duplicate refetch

- **Tác động:** tăng network/DB load và có thể làm danh sách nặng chậm thêm.
- **Root cause:** không có mutation-origin dedupe/suppression.
- **Hướng sửa:** client/mutation ID hoặc suppression window theo entity/domain.

### High — Event-driven eager prefetch quá rộng

- **Tác động:** invoices/contracts query nặng được tải nền dù user không dùng.
- **Root cause:** mọi visible tab đều có thể `prefetchDomain` sau event.
- **Hướng sửa:** active-query only, stale-only cho cache không active, intent-based prefetch.

### High — Read models quá nặng

- **Tác động:** list queries có mean từ 0,8 đến hơn 2 giây.
- **Root cause:** `select *`, exact count, nested relations, lateral embeds và supplemental RPC.
- **Hướng sửa:** compact list RPC/view, cursor pagination, lazy detail và query-specific indexes.

### High — RLS helper đắt đối với realtime fan-out

- **Tác động:** throughput giảm theo số subscriber, không chỉ theo write rate.
- **Root cause:** authorization helper phức tạp và nhiều shared block hits.
- **Hướng sửa:** set-based/indexed lookup, cached initplan và benchmark với JWT thật.

### Medium — Publication/migration drift

- **Tác động:** production và môi trường dựng lại có thể hoạt động khác nhau.
- **Hướng sửa:** reconciliation migration, audit `schema_migrations` và publication trong CI/deploy verification.

## 7. Các phương án kiến trúc

### Phương án A — Publish Postgres Changes cho mọi bảng

- **Ưu điểm:** triển khai ban đầu nhanh, ít abstraction frontend.
- **Nhược điểm:** RLS authorization nhân theo subscriber, DELETE khó filter, fan-out cao, dễ tạo bão invalidate.
- **Đánh giá:** không khuyến nghị cho toàn hệ thống.

### Phương án B — Polling/refetch thuần

- **Ưu điểm:** dễ hiểu, ít phụ thuộc websocket.
- **Nhược điểm:** tốn bandwidth, dữ liệu có độ trễ và không tạo cảm giác tức thì.
- **Đánh giá:** chỉ phù hợp làm fallback/catch-up cho một số màn.

### Phương án C — Hybrid local-first + domain signal

- **Ưu điểm:** cùng client tức thì, cross-client đủ nhanh, kiểm soát được query load và scale tốt hơn.
- **Nhược điểm:** cần dependency registry và mutation discipline rõ ràng.
- **Đánh giá:** phương án khuyến nghị.

Supabase khuyến nghị Broadcast cho phần lớn use case cần scalability và security; Postgres Changes đơn giản hơn nhưng scale kém hơn. Tham khảo: [Subscribing to Database Changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes).

## 8. Kiến trúc mục tiêu

| Hiện tại | Mục tiêu |
|---|---|
| Mutation → invalidate → refetch | Mutation response → cập nhật UI/cache ngay |
| Realtime dùng cho cả chính client vừa ghi | Realtime chủ yếu cho tab/client khác |
| Query dependency hard-code | Registry typed theo domain/source |
| Event luôn invalidate + prefetch | Patch, invalidate hoặc stale-only tùy query |
| List `select *` + exact count + enrichment | Read model gọn, cursor, detail lazy-load |
| Không biết websocket đang khỏe hay lỗi | Channel health + reconnect catch-up |
| Event toàn cục theo bảng | Signal theo `organization_id`/private topic |

### 8.1. Local command path

```text
User mutation
  → server transaction
  → canonical response
  → set entity/detail/list cache ngay
  → UI render
  → background reconcile aggregate/stats
```

TanStack Query hỗ trợ trực tiếp pattern dùng mutation response với `setQueryData`, tránh refetch dữ liệu server vừa trả. Tham khảo: [Updates from Mutation Responses](https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses).

### 8.2. Cross-client event path

```text
Database/domain change
  → org-scoped Postgres Change hoặc private Broadcast
  → typed domain registry
  → patch entity hoặc invalidate aggregate đang active
  → authoritative refetch qua RLS khi cần
```

Event chỉ là signal. Dữ liệu authoritative vẫn đi qua query/RPC và RLS hiện có.

### 8.3. Freshness tiers

**Tier A — Realtime vận hành:**

- Customers và vehicles.
- Contracts, contract customers/services/terminations.
- Invoices, invoice items và payments.
- Income-expenses và accounts.
- Rooms/buildings.
- Meters/readings.
- Jobs và notifications.

**Tier B — Aggregate/dashboard:**

- Invalidate có debounce/coalescing.
- Chỉ refetch khi query active hoặc user quay lại màn.
- Không eager prefetch toàn domain theo từng event.

**Tier C — Báo cáo/historical:**

- Stale-only hoặc refresh theo intent.
- Có thể dùng focus/reconnect/manual refresh thay vì sub-second realtime.

## 9. Kế hoạch triển khai

### Giai đoạn 0 — Instrumentation và SLA

- [ ] Gắn timing cho mutation start, server response, local render và reconciliation complete.
- [ ] Gắn timing cross-client từ write đến UI update.
- [ ] Đếm request và query phát sinh trên từng thao tác.
- [ ] Ghi channel status, reconnect count và catch-up duration.
- [ ] Chốt baseline cho customers, contracts, invoices, vehicles, meters, finance và jobs.
- [ ] Thêm E2E helper kiểm tra console errors và network request count.

**Kết quả đầu ra:** dashboard/log đo được p50/p95/p99 và số request cho từng flow trọng yếu.

### Giai đoạn 1 — Sửa flow tạo khách từ hợp đồng

- [ ] Viết regression test chứng minh customer vừa tạo chưa xuất hiện local ngay.
- [ ] Thêm `onCreated(customer)` cho `CreateCustomerDialog`.
- [ ] Truyền customer canonical về `CustomerSelectionDialog`.
- [ ] Chèn immutable vào picker state/cache và auto-select ngay.
- [ ] Giữ reconciliation chạy nền, không chặn UI.
- [ ] Tạo query/hook picker riêng chỉ lấy `id`, `full_name`, `phone`, `id_number`.
- [ ] Thêm server search và cursor/limit.
- [ ] Bỏ exact count khỏi picker.
- [ ] Bỏ contract/room/building enrichment khỏi picker.
- [ ] Nếu customer + vehicles phải atomic, đưa vào một transactional RPC.
- [ ] Thêm same-client echo regression test.
- [ ] Chạy production-like E2E với 501+ customers.

**Mục tiêu:** 8 request xuống 1 request; customer xuất hiện local trong ≤100 ms.

### Giai đoạn 2 — Typed query dependency registry

- [ ] Chuẩn hóa query-key factories theo domain.
- [ ] Khai báo metadata: `domain`, `sources`, `freshnessTier`, `eventStrategy`.
- [ ] Hỗ trợ ba strategy: `patch`, `invalidate`, `stale-only`.
- [ ] Chuyển mutation entity/detail sang dùng canonical response.
- [ ] Thêm mutation origin/client ID hoặc suppression window.
- [ ] Chỉ refetch aggregate thật sự phụ thuộc entity vừa thay đổi.
- [ ] Thêm test kiểm tra mọi query source đều có dependency mapping.
- [ ] Thêm test ngăn query root mới bị bỏ sót khỏi registry.

**Kết quả đầu ra:** hub không còn phụ thuộc chủ yếu vào danh sách query key hard-code thủ công.

### Giai đoạn 3 — Hoàn thiện realtime Tier A

- [ ] Lập bảng canonical `source table → domain signal → affected queries`.
- [ ] Thêm org filter cho Postgres Changes nơi bảng có `organization_id` phù hợp.
- [ ] Dùng parent touch/domain version/Broadcast cho junction hard-delete.
- [ ] Hoàn thiện customers/vehicles signals.
- [ ] Hoàn thiện contracts/junctions/terminations signals.
- [ ] Hoàn thiện invoices/items/payments signals.
- [ ] Hoàn thiện rooms/buildings signals.
- [ ] Hoàn thiện meters/readings signals.
- [ ] Hoàn thiện income-expenses/accounts signals.
- [ ] Hoàn thiện jobs và notifications signals.
- [ ] Reconcile publication bằng migration idempotent.
- [ ] Xác minh mọi view migration bằng `node scripts/check-view-invoker.mjs`.

**Kết quả đầu ra:** cross-client Tier A đạt SLA mà không publish cơ học mọi bảng.

### Giai đoạn 4 — Compact read models và database tuning

- [ ] Tạo compact customer picker RPC/query.
- [ ] Tạo compact contracts list read model.
- [ ] Tạo compact invoices list read model.
- [ ] Tạo compact vehicles list read model.
- [ ] Lazy-load items/payments/customer embeds khi mở detail.
- [ ] Tách exact count/stats khỏi list query.
- [ ] Chuyển list lớn sang cursor pagination.
- [ ] Chọn `pg_trgm` hoặc FTS phù hợp với search behavior thực tế.
- [ ] Chạy `EXPLAIN (ANALYZE, BUFFERS)` trước và sau mỗi index.
- [ ] Tối ưu `can_access_org_entity`/`has_any_scope_v3` theo set-based/indexed lookup.
- [ ] Benchmark RLS bằng JWT các role chủ nhà, kế toán và quản lý.
- [ ] Chạy `node scripts/reconcile-money.mjs [YYYY-MM]` cho mọi thay đổi đụng số tiền.

**Kết quả đầu ra:** operational lists p95 ≤800 ms, không còn query list 2 giây do tải relation quá rộng.

### Giai đoạn 5 — Health, reconnect và Broadcast scale path

- [ ] Xử lý `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`.
- [ ] Hiển thị/ghi metric realtime health.
- [ ] Khi reconnect, version-check hoặc refetch query đang active.
- [ ] Khi window focus, catch-up theo domain thay vì refetch toàn bộ.
- [ ] Bỏ eager `prefetchDomain` theo mọi event.
- [ ] Thêm intent-based prefetch cho navigation thực tế.
- [ ] Chuyển domain fan-out lớn sang private Broadcast theo org.
- [ ] Giữ Postgres Changes cho các domain có subscriber/write rate thấp và RLS rẻ.

**Kết quả đầu ra:** mất kết nối không làm cache stale vô thời hạn; fan-out không tăng tuyến tính ngoài kiểm soát.

### Giai đoạn 6 — Multi-context E2E và rollout

- [ ] Test hai browser contexts cùng organization.
- [ ] Test hai browser contexts khác tenant để chứng minh không lọt event/dữ liệu.
- [ ] Test same-client mutation không duplicate full refetch.
- [ ] Test offline, tab sleep và reconnect catch-up.
- [ ] Test bulk invoice generation/import để kiểm tra event storm.
- [ ] Test soft-delete và hard-delete junction behavior.
- [ ] Luôn kiểm console errors.
- [ ] Canary từng domain theo thứ tự customers → contracts → invoices → finance/meters/jobs.
- [ ] So sánh p95, request count và DB load trước/sau mỗi phase.
- [ ] Rollback domain nếu SLA hoặc database load regression.

**Kết quả đầu ra:** rollout có số liệu, cross-tenant negative test và rollback boundary rõ ràng.

## 10. KPI nghiệm thu

| KPI | Mục tiêu |
|---|---:|
| Cập nhật UI local sau thao tác | ≤100 ms |
| CRUD được server xác nhận | p95 ≤800 ms |
| Client khác nhận thay đổi | p95 ≤1,5 giây |
| Client khác nhận thay đổi | p99 ≤2 giây |
| Reconnect/focus catch-up | ≤2 giây |
| Customer picker | 1 request |
| Customer picker latency | p95 ≤500 ms |
| Duplicate full refetch do same-client echo | 0 |
| Danh sách vận hành | p95 ≤800 ms |
| Báo cáo nặng | ≤2 giây |
| Cross-tenant event/data leak | 0 |

## 11. Chiến lược kiểm thử

### Unit tests

- Dependency registry mapping.
- Debounce/coalescing behavior.
- Same-client echo suppression.
- Immutable entity/list cache patching.
- Reconnect state machine.
- Domain version comparison.

### Integration tests

- Mutation response cập nhật cache trước background reconciliation.
- Child/junction mutation phát đúng parent/domain signal.
- Active query refetch; inactive query chỉ stale.
- RLS giữ nguyên khi dùng compact RPC/view.

### E2E tests

- Tạo khách từ hợp đồng và auto-select tức thì.
- Hai client cùng org thấy thay đổi trong SLA.
- Hai tenant không nhận dữ liệu của nhau.
- Reconnect sau offline nhận đủ state hiện tại.
- Bulk operation không gây request storm.
- Fixture chỉ ghi vào org DEMO và tự cleanup.
- Không có console errors ngoài nhiễu mạng đã lọc.

## 12. Trạng thái xác minh tại thời điểm audit

- `npx vitest run src/hooks/__tests__/useRealtimeDataSync.test.ts`: 23/23 test pass.
- E2E headless flow tạo khách từ hợp đồng: pass.
- Test body của flow khoảng 14,4 giây.
- Dữ liệu test DEMO đã được dọn sạch.
- Không ghi nhận console error trong flow audit.
- Browser plugin tích hợp báo không có browser; audit đã fallback sang Playwright headless theo quy định repo.
- Test hiện tại mới phủ mapping/debounce; chưa phủ reconnect, channel errors, same-client echo hoặc cross-client SLA.
- Audit này chưa sửa code production, chưa apply migration và chưa thay đổi dữ liệu org thật.

## 13. Thứ tự triển khai khuyến nghị

Không triển khai toàn bộ publication/realtime trong một đợt lớn. Thứ tự an toàn và có khả năng chứng minh giá trị nhanh nhất:

1. Giai đoạn 0: instrumentation và SLA.
2. Giai đoạn 1: customer picker + local-first create flow.
3. Giai đoạn 2: typed dependency registry + echo suppression.
4. Giai đoạn 3: hoàn thiện realtime Tier A từng domain.
5. Giai đoạn 4: read models, RLS và index tuning.
6. Giai đoạn 5: health/reconnect và Broadcast scale path.
7. Giai đoạn 6: multi-context E2E và canary rollout.

Lát cắt đầu tiên nên chứng minh được ba điều trước khi mở rộng:

- Customer mới xuất hiện và được chọn trong ≤100 ms.
- Picker giảm từ 8 request xuống 1 request.
- Event của chính client không gây vòng full refetch thứ hai.

## 14. Tài liệu tham khảo

- [Supabase — Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase — Subscribing to Database Changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [TanStack Query — Updates from Mutation Responses](https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses)
- [TanStack Query — Invalidations from Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations)

---

## 15. Audit đối chiếu thực tế (phiên độc lập, 2026-07-29)

> Phần này được **thêm vào cuối tài liệu, không sửa nội dung §1–§14**.
>
> Mục đích: kiểm chứng từng khẳng định của bản kế hoạch bằng code thật + database
> production, đánh giá tính khả thi và đề xuất điều chỉnh.
>
> Phương pháp: 7 cụm khẳng định được kiểm bởi 7 tác nhân độc lập, sau đó **mọi
> khẳng định bị chấm sai/một phần đều bị một tác nhân đối kháng thứ hai phản biện**
> (nhiệm vụ của tác nhân này là *bác bỏ* kết luận của tác nhân đầu). Truy vấn DB
> chỉ đọc, qua Management API, project `tryymsxyyckgbrmmvozx`.

### 15.1. Kết quả chấm điểm

**87 khẳng định** được chấm. Sau vòng phản biện:

| Kết quả | Số lượng | Ghi chú |
|---|---:|---|
| ĐÚNG | 61 | tái lập được bằng code/SQL |
| ĐÚNG MỘT PHẦN | 25 | phần lớn là **stale** hoặc khác phương pháp đếm, không phải sai |
| SAI | 1 | §9 G5 "Thêm intent-based prefetch" — tính năng đã có từ 05/07 |

**Kết luận tổng:** phần chẩn đoán (§3–§5) của bản kế hoạch **đáng tin cậy**. Vấn đề
nằm ở **thứ tự triển khai (§9, §13), cách định cỡ (68 checkbox không có cut line),
và một số mục đề xuất lại việc đã làm xong**. Không nên vứt §3–§5 cùng với §9–§13.

Một cảnh báo về quy trình: vòng kiểm đầu chấm 15 khẳng định là "SAI", vòng phản biện
lật lại 14 trong số đó. Nguyên nhân gần như luôn là **đo ở commit khác** hoặc **dùng
regex khác**. Bài học áp dụng cho chính bản kế hoạch này: mọi con số phải ghi kèm
commit và lệnh đo.

### 15.2. Bảng §2 thống kê tĩnh — tái lập ĐÚNG tại commit của chính nó

Nghi ngờ ban đầu rằng bảng §2 được "ước lượng" là **sai**. Đo lại tại commit
`e41da93`/`7e6b3a9` (cây mà audit thực sự chạy trên đó), phạm vi
`src/components + src/hooks + src/pages + src/lib (+integrations)`, loại test:

| Hạng mục | Doc | Đo lại | Đánh giá |
|---|---:|---:|---|
| File TS/TSX production | 812 | **812** | khớp tuyệt đối |
| `useQuery` | 301 | **301** | khớp tuyệt đối (dạng `useQuery({`) |
| Literal query-key roots | 196 | **196** | khớp tuyệt đối |
| Direct database/storage sources | 98 | **98** | khớp tuyệt đối |
| `invalidateQueries` | 536 | 537 | lệch 1 |
| `useMutation` | 279 | 282 | lệch 3 |
| Bảng có mutation trực tiếp | 59 | 57 | lệch 2 |
| `setQueryData`/`setQueriesData` | 9 | **9 file** / 16 call site | **dán nhãn sai** |

**Chỉ một dòng cần sửa:** "9" là **số FILE**, trong khi mọi dòng khác là **số lần
gọi**. Số call site thật là 16 (non-test) / 44 (kể cả test). Nên viết lại thành
`setQueryData/setQueriesData | 16 (trong 9 file)`.

Ba bổ sung cho bảng này:

1. **`useInfiniteQuery` xuất hiện 0 lần** trong toàn repo (`useSuspenseQuery` cũng 0).
   Nhãn cột gợi ý đã có hạ tầng phân trang tăng dần — thực tế bằng 0. Mục "cursor
   pagination" (§1 điểm 6, §9 G4) là **greenfield**, không phải mở rộng.
2. **Đã tồn tại sẵn implementation optimistic chuẩn sách giáo khoa**:
   [`src/hooks/useBuildings.ts:249-271`](../../src/hooks/useBuildings.ts) có đủ
   `cancelQueries → getQueryData snapshot → setQueryData → onError rollback →
   onSettled invalidate`. Trong phạm vi kế hoạch còn `useUiPreferences` (1 mutation)
   dùng cùng pattern; tỉ lệ mutation optimistic thật vẫn ở mức **dưới 2%**.
   §6-Critical-1 trình bày local-first như kiến trúc phải xây mới; thực tế là
   **port một pattern đã chạy production** — rẻ hơn nhiều so với doc ngụ ý.
3. **20 bảng chỉ truy cập được qua `.from("x" as any)`** do `types.ts` drift
   (teams, materials\_\*, profit_manager\_\*, meter_readings_detailed…). Registry
   dependency **có type** mà §6 đề xuất sẽ **không phủ được 20 bảng này** cho tới
   khi `types.ts` được regen.

### 15.3. Những phần đã STALE — cần sửa nội dung

#### §4.7 (notifications) — đúng lúc viết, sập sau 4 phút 23 giây

Tài liệu commit lúc `b18272e` **19:41:49**; commit `99b87e4` lúc **19:46:12** đã mount
`NotificationsRealtime`. Trạng thái thực tế **hiện nay**:

- [`src/App.tsx:14`](../../src/App.tsx) + [`:238`](../../src/App.tsx) — đã mount, dưới `<RealtimeDataSync />`.
- `public.notifications` **đã nằm trong publication production**.
- RLS own-row đã có: 4 policy PERMISSIVE (`user_id = (SELECT auth.uid())`) + 1
  RESTRICTIVE `notifications_org_boundary`.
- Kênh dùng **server-side filter** `user_id=eq.<uid>` và **chỉ nghe INSERT**
  ([`useNotifications.ts:346-353`](../../src/hooks/useNotifications.ts)).

⇒ §4.7 phải **viết lại**: notifications không phải WIP, mà là **đường realtime chặt
nhất trong toàn repo** — chặt hơn hub trung tâm. Nó nên là **mẫu tham chiếu** cho
gạch đầu dòng "Thêm org filter cho Postgres Changes" (§9 G3), chứ không phải một
hạng mục phải làm.

#### §4.1 — publication là 17 bảng, không phải 16

Thiếu đúng `notifications`. Phân loại theo tiểu hệ ở §4.1 **chính xác 100%**.

#### §5.3 — suy luận "không có trong `schema_migrations` ⇒ chưa apply" là SAI trong repo này

Đây là lỗi suy luận nghiêm trọng nhất của tài liệu, và nó làm **hạ bậc sai** một
finding lẽ ra phải cao hơn:

- `schema_migrations`: **360 dòng, max version = `20260716170000`** — sổ ghi migration
  đã **chết từ 2026-07-16**.
- Repo có ~507 file `.sql`; **143 version local vắng sổ** — không phải 2.
- Bằng chứng phản chứng dứt khoát: `20260729130000_notifications_rls_own_row.sql`
  nằm trong nhóm vắng sổ, nhưng **5 policy của nó đang tồn tại thật trên production**.

⇒ Quy trình thực tế của repo là apply qua Management API **không ghi sổ**. Rủi ro
**ngược lại** với mô tả của tài liệu: production có catalog **không có migration bảo
chứng**, nên `supabase db reset`/dựng môi trường mới sẽ **mất** publication,
RLS notifications và toàn khối finance_v2. Đề nghị **nâng "Medium — Publication/migration
drift" lên High**, và đổi hướng sửa từ "reconcile 2 migration" thành "khôi phục sổ
ghi migration cho 143 version".

#### §6/§9 G4 — tối ưu RLS helper là việc ĐÃ LÀM XONG

[`docs/audits/AUDIT-HIEU-NANG-2026-07-26.md`](AUDIT-HIEU-NANG-2026-07-26.md) §6 ghi
migration `20260726130000` đã chuyển `can_access_org_entity`/`has_any_scope_v3` sang
set-based, đo trên prod:

| Query | Trước | Sau |
|---|---:|---:|
| `count(*)` customers (504 dòng) | 2.610 ms | **11,6 ms** |
| `count(*)` meter_readings_detailed | 4.086 ms | ~44 ms |
| `select *` jobs | 1.059 ms | ~47 ms |

⇒ Con số **8,8 ms initplan** mà §5.2 đo được **chính là trạng thái SAU tối ưu**.
Checkbox §9 G4 dòng 472 ("Tối ưu `can_access_org_entity`/`has_any_scope_v3` theo
set-based/indexed lookup") đang **đề xuất lại việc đã hoàn thành 3 ngày trước**. Nên xoá.

#### Ba hạng mục khác đã tồn tại

| Checkbox | Thực tế |
|---|---|
| §9 G5 "Thêm intent-based prefetch" | **Đã có từ 05/07** — `src/lib/prefetchIntent.ts` (commit `d51f6e7`), dùng ở `Sidebar.tsx` + `HomeLauncher.tsx` |
| §9 G0 "E2E helper kiểm console errors" | **Đã có** — `trackConsoleErrors` (`.e2e-fleet/specs/auth.ts:52`), **28 file** đang dùng |
| §9 G3 "Lập bảng canonical source → signal → queries" | **Đã có** — [`docs/he-thong/realtime-sync.md`](../he-thong/realtime-sync.md), 194 dòng, chính là artifact đó |

Riêng mục cuối là vấn đề về nguồn sự thật: tài liệu **không hề tham chiếu**
`realtime-sync.md` (§14 chỉ có link ngoài), trong khi chính hub trỏ tới nó ở
[`useRealtimeDataSync.ts:95`](../../src/hooks/useRealtimeDataSync.ts). File đó đã có
sẵn §3 bản đồ bảng→query key, §5 danh sách **có chủ ý** bỏ realtime (= Tier C của
§8.3), §6 nguyên tắc **"mutation lo tức thì cho client hiện tại; hub lo cross-client"**
(= chính "kiến trúc mục tiêu" §8). ⇒ Kiến trúc §8 **không mới**; cái thiếu là lớp 1
đang được cài bằng `invalidate` thay vì `setQueryData`. Nên phát biểu lại §8 theo
hướng đó, và nói rõ registry (§9 G2) **thay thế** hay **bổ sung** cho tài liệu này —
hai nguồn sự thật cạnh tranh đúng là lỗi mà registry định diệt.

### 15.4. Những gì kế hoạch BỎ SÓT (bổ sung, xếp theo mức độ)

#### ★★★ 1. Chi phí realtime lớn nhất không phải RLS — mà là chính WAL poller

`realtime.list_changes` chiếm **25,5% toàn bộ thời gian thực thi database**
(6,7 giờ / 26,2 giờ tích lũy), gấp ~5 lần statement đứng thứ hai. Nó chạy **bất kể
có ai subscribe hay không**.

⇒ Toàn bộ §5.2 phân tích chi phí theo trục `RLS × subscriber`, nhưng chi phí thật
lớn nhất là **chi phí cố định theo số bảng trong publication**. Mọi đề xuất "thêm
bảng vào publication" (§9 G3) đều làm tăng con số này. Đây phải là mục §5 riêng.

#### ★★★ 2. *(ĐÃ GỠ 2026-08-11 — ngoài phạm vi)*

Mục này đề xuất DROP 5 bảng `network_*` khỏi publication. Đã gỡ theo banner đầu tài
liệu: Network Center nay là tiểu hệ đang chạy production và consume đúng 5 bảng đó.
Giữ lại số thứ tự để mọi tham chiếu ★★★n trong §16 không lệch.

#### ★★★ 3. Debounce 800 ms không có maxWait — bị starve, không "gộp bão" như comment tự nhận

[`useRealtimeDataSync.ts:262-270`](../../src/hooks/useRealtimeDataSync.ts) là debounce
trailing-edge thuần: mỗi event `clearTimeout` rồi đặt lại 800 ms, **không có giới hạn
chờ tối đa**. Trong một đợt bulk phát event dày hơn 1 lần/800 ms, `flushEntry`
**không chạy lần nào** cho tới khi cơn bão dứt hẳn.

Nghiêm trọng hơn: `businessPerformanceTimer` ([:237](../../src/hooks/useRealtimeDataSync.ts),
[:246-254](../../src/hooks/useRealtimeDataSync.ts)) là **MỘT biến duy nhất dùng chung
cho cả 5 bảng** invoices/income_expenses/contracts/rooms/buildings — event từ bất kỳ
bảng nào cũng reset nó.

⇒ Comment ở dòng 12-14 tự nhận "gộp cơn bão đó về 1 lần invalidate" chỉ đúng **sau khi
bão kết thúc**; trong suốt đợt sinh hoá đơn hàng loạt, dashboard đứng số mà không có
tín hiệu nào. Đây là **lỗi tiềm ẩn thật trong đúng 40 dòng mà §4.2/§4.5 đang mổ xẻ**
nhưng không nêu. Fix ~6 dòng (flush cưỡng bức sau 2–3 s), thuộc lát cắt đầu tiên.

#### ★★★ 4. KPI "Cross-tenant event/data leak = 0" hiện KHÔNG đạt — và không thể đạt với Postgres Changes

Hai sự thật đã đo:

1. **Toàn bộ 17 bảng có `relreplident = 'd'`** (replica identity default) ⇒ WAL cho
   DELETE **chỉ chứa primary key**.
2. Hub đăng ký `{ event: "*" }` **không filter** cho 7 bảng business
   ([:242](../../src/hooks/useRealtimeDataSync.ts)).

Theo tài liệu chính thức Supabase, **RLS không được áp cho sự kiện DELETE** (không thể
lọc bản ghi đã xoá).

⇒ Đây là **điều kiện hiện tại của production**, không phải rủi ro của việc mở rộng.
§10 đặt nó làm KPI tương lai; thực tế phải xử lý ngay hoặc phát biểu lại KPI cho trung
thực.

#### ★★★ 5. Org filter + replica identity DEFAULT = giết luôn sự kiện DELETE

Checkbox §9 G3 "Thêm org filter cho Postgres Changes nơi bảng có `organization_id`"
khả thi về mặt cột (14 bảng Tier A đều có). Nhưng với replica identity DEFAULT,
`organization_id=eq.<uuid>` **không bao giờ khớp DELETE** vì WAL chỉ có PK ⇒ Supabase
sẽ **không gửi** event DELETE.

Cách sửa (`ALTER TABLE … REPLICA IDENTITY FULL`) ghi **toàn bộ dòng cũ** vào WAL —
khuếch đại ghi, cộng dồn vào chi phí ở mục 1. ⇒ Đây là **quyết định schema toàn cục**,
không phải một checkbox. Nếu ship mà không xem xét, hard-delete
(`contract_customers`, `contract_services`) **ngừng lan truyền cross-client** — đúng
loại bug mà §4.3 đang muốn diệt.

#### ★★ 6. Giai đoạn 5 "private Broadcast" có 0% hạ tầng

`realtime.messages` **đã bật RLS nhưng có 0 policy** (`select count(*) from pg_policies
where schemaname='realtime'` → **0**). ⇒ Mọi channel `config: { private: true }` sẽ bị
**từ chối authorization**. §7 Phương án C và §9 G5 viết như thể chỉ là việc code
frontend; thực tế cần viết policy cho `realtime.messages` trước, và đó là bề mặt bảo
mật mới hoàn toàn.

#### ★★ 7. `count: 'exact'` bắt mọi list trả giá RLS InitPlan HAI LẦN

PostgREST bọc query trong `pgrst_source` + `pgrst_source_count`; nhánh count **quét
lại toàn bộ** dưới cùng bộ predicate RLS và **chạy lại InitPlan**. Đo trên picker:
**27,3–28,2 ms có count vs 12,6 ms không count (~2,2×)**.

Cả 4 list đều truyền `{ count: 'exact' }` (`useInvoices.ts:105`, `useCustomers.ts:90`,
`useVehicles.ts:36-50`, `useContracts.ts:278`).

⇒ Đây là hạng mục **rẻ nhất và có bằng chứng đo được rõ nhất** của Giai đoạn 4
(đổi 1 dòng), nhưng đang bị xếp **thứ 6/13**. Phải lên đầu.

#### ★★ 8. Quy mô thật quá nhỏ cho luận điểm scale — nhưng write amplification thì không

| Chỉ số | Thực tế |
|---|---:|
| `auth.users` | **11** (6 đăng nhập trong 7 ngày) |
| Kích thước DB | **151 MB** |
| invoices / contracts / customers / income_expenses | 903 / 337 / 519 / 2.613 dòng |
| Subscription realtime đang sống | ~1–2 |

Nhưng: **`invoices` có 664.258 row-version UPDATE** (~735 update/dòng),
`income_expenses` 496.814. ⇒ Driver thật của fan-out là **write amplification**, không
phải subscriber count.

Hệ quả cho kế hoạch:

- §5.2/§7-A/§9 G5 (Broadcast, fan-out) **định cỡ cho một hệ thống không tồn tại** —
  nên cắt hoặc hoãn vô thời hạn.
- "Cursor pagination" ở bảng 903 dòng **không mua được gì**, trong khi là hạng mục
  **xâm lấn nhất** (đổi mọi component phân trang + mọi query key).
- Việc đáng làm là **giảm write amplification** (trigger churn, mass status recalc) —
  tài liệu không hề nhắc.

#### ★★ 9. Ưu tiên theo thời gian DB thật khác với ưu tiên của tài liệu

Tổng thời gian thực thi theo bảng gốc, **chỉ tính bảng trong phạm vi**:
**contracts 164,6 phút** → **invoices 128,3** → **notifications 126,4** →
income_expenses 72,2 → … → **customers chỉ đứng thứ 10 (28,4 phút)**.
(Thứ hạng giữ nguyên vị trí gốc; bảng của các tiểu hệ ngoài phạm vi đã lược bỏ.)

⇒ Case study §3 chọn đúng flow **gây khó chịu nhất cho người dùng**, nhưng đó **không
phải điểm nóng DB lớn nhất**. Nên nói rõ điều này để §9 G4 không bị ưu tiên nhầm — và
lưu ý `notifications`, thứ mà §4.7 gạt đi là "chưa production-ready", đã là workload
đọc nặng **thứ 3**.

#### ★ 10. Chi phí RLS mỗi event khác nhau theo bảng — §5.2 khái quát từ bảng RẺ NHẤT

Đo dưới JWT authenticated org thật: `customers` → 11,1–12,4 ms; **`invoices` → 42,0–44,0 ms**
(chuỗi policy thêm một InitPlan và một SubPlan building scope). ⇒ Phép tính fan-out
của §5.2 **lạc quan ~4×** ở trường hợp xấu nhất, và `invoices` chính là bảng nhiều
event nhất.

#### ★ 11. `pg_stat_statements.track_planning = off` — mọi số §5.1 thiếu planning time

Planning đo được 4,7–6,8 ms trên picker, so với 11,4–28,2 ms execution ⇒ **20–40% chi
phí ẩn**, và nặng nhất đúng ở các statement RLS-heavy. Mọi benchmark trước/sau dựa
trên §5.1 sẽ **đo thiếu** phần lợi ích của việc giảm số policy.

#### ★ 12. Multi-tab: `hubActive` là biến module ⇒ N tab = N websocket = N prefetch storm

[`:224`](../../src/hooks/useRealtimeDataSync.ts) `let hubActive = false;` là guard
**theo JS realm, tức theo tab**. 3 tab = 3 channel = 3 lần `flushEntry` + tới 3
`prefetchDomain` đồng thời. Không có leader election (BroadcastChannel/Web Lock).
⇒ Baseline đo bằng Playwright 1 tab ở Giai đoạn 0 **không phản ánh thực tế** người
quản lý mở nhiều tab — cả khung SLA bị hiệu chỉnh sai workload.

Kèm theo, nhánh `if (!userId || hubActive) return;` **không trả về cleanup**: nếu
instance thứ nhất unmount trước, `hubActive` về `false` nhưng instance thứ hai
**không tự re-subscribe** (deps không đổi) ⇒ **mất realtime im lặng**, không log,
không status callback để phát hiện.

#### ★ 13. Channel notifications cũng không có status callback

§4.6 chỉ soi hub. Trong phạm vi kế hoạch có **hai** channel và **cả hai** đều
`.subscribe()` không callback: hub (`useRealtimeDataSync.ts`) và
`useNotifications.ts:360`. ⇒ Giai đoạn 5 phải bao **cả hai**, nếu không chỉ vá nửa
bề mặt. *(Danh sách gốc còn kể hai channel Zalo — đã gỡ 11/08, ngoài phạm vi.)*

#### ★ 14. `useSyncContractServices` có cùng anti-pattern nhưng §4.3 chỉ nêu một

[`useContracts.ts:696-736`](../../src/hooks/useContracts.ts): `delete().eq("contract_id")`
rồi `insert(rows)` trên `contract_services`, `onSuccess` chỉ invalidate cục bộ.
`contract_services` cũng **không** nằm trong publication. ⇒ Mọi giải pháp (touch parent
/ domain_version / broadcast) phải áp **cho cả hai hook cùng lúc** — nếu không, sửa
xong `contract_customers` vẫn còn nguyên lỗ ở dịch vụ hợp đồng, vốn ảnh hưởng **trực
tiếp tới đơn giá điện nước và số tiền hoá đơn**.

#### ★ 15. Bug tiềm ẩn nằm ngay trong hook được dùng làm case study

| Vị trí | Vấn đề |
|---|---|
| [`VehicleFormDialog.tsx:94-99`](../../src/components/vehicles/VehicleFormDialog.tsx) | `useCustomers(…, { page: 1, pageSize: 500 })` trong khi org thật có **501 khách active** ⇒ `.range(0,499)` **cắt mất 1 khách, im lặng**. Càng lệch khi khách tăng. |
| [`CustomerSelectionDialog.tsx:45`](../../src/components/contracts/CustomerSelectionDialog.tsx) | Không truyền pagination ⇒ không có `.range()`, phụ thuộc **PostgREST `max_rows = 1000`**. Ở 1001 khách, picker **im lặng** bỏ khách mới nhất; `handleConfirm` lọc theo `customers` nên khách đã chọn ngoài cửa sổ bị **âm thầm loại khỏi hợp đồng**. |
| [`useCustomers.ts:308`](../../src/hooks/useCustomers.ts) | `await supabase.from("vehicles").insert(...)` **không destructure `error`, không throw** ⇒ tạo khách kèm xe mà phần xe fail vẫn chạy `onSuccess` và toast **"Dữ liệu đã được TẠO thành công"**. Đối chiếu: `syncCustomerVehicles` cùng file kiểm `error` sau mọi thao tác. **Fix 1 dòng.** |

⇒ Hai mục đầu biến §3 từ "vấn đề UX chậm" thành **"nguy cơ mất dữ liệu im lặng cách
2× tăng trưởng"** — đủ để đẩy Giai đoạn 1 lên đầu mà không cần tranh luận về latency.
Mục thứ ba biến giả định §9 dòng 425 ("**Nếu** customer + vehicles phải atomic") thành
yêu cầu bắt buộc.

> Ghi chú công bằng: `useContracts.ts:1160` ghi vào bảng `public.cash_book` **không
> tồn tại**, nhưng nhánh đó nằm **sau** canonical RPC `approve_contract_termination_v1`
> — đã xác nhận **có trên production** — nên hiện **không kích hoạt**. Là code chết,
> nên xoá, không phải bug đang chạy.

### 15.5. Đánh giá kế hoạch triển khai (§9, §13)

#### Giai đoạn 0 đang CHẶN thứ duy nhất tự trả công cho nó

Repo có **0 hạ tầng telemetry**: `package.json` không có sentry/posthog/web-vitals/
analytics; `src/` không có `performance.mark`/`measure`. ⇒ Đầu ra tự đặt của Giai đoạn 0
("dashboard/log đo được p50/p95/p99 cho từng flow trọng yếu") là một **dự án
observability from-scratch**, không phải bước chuẩn bị.

§13 lại xếp nó **trước** Giai đoạn 1 — đảo ngược chính lời hứa "thứ tự an toàn và có
khả năng chứng minh giá trị nhanh nhất". Một người bảo trì đơn lẻ sẽ hoặc bỏ qua Giai
đoạn 0 (khiến bảng KPI không cưỡng chế được), hoặc mắc kẹt ở đó và không bao giờ tới
Giai đoạn 1.

#### KPI p95/p99 cross-client là không đo được

Cần đồng hồ chung giữa 2 client (timestamp ghi từ server đưa vào payload + timestamp
nhận ở client) và **hàng trăm mẫu** cho p99. Hệ thống có **11 tài khoản** ⇒ lưu lượng
thật sẽ **không bao giờ** sinh đủ mẫu. Thêm nữa, hub **cố ý bỏ payload**
([:16-18](../../src/hooks/useRealtimeDataSync.ts)) nên không có clock source.

⇒ Thay bằng **phép đo tổng hợp 2 browser context bằng Playwright, N=20, báo `max` thay
vì p99**. KPI không đo được sẽ trở thành KPI được **tuyên bố** là đạt — và điều đó làm
hỏng luôn cơ chế "Rollback domain nếu SLA regression" của §6.

#### 68 checkbox, không sizing, không cut line

Phân bố: G0=6, G1=12, G2=8, G3=12, G4=12, G5=8, G6=10. Vài checkbox đơn lẻ tự nó là
dự án nhiều tuần ("Chốt baseline cho customers, contracts, invoices, vehicles, meters,
finance và jobs"; "Chuyển domain fan-out lớn sang private Broadcast theo org").
Trong khi đó `CLAUDE.md` yêu cầu mỗi thay đổi phải: typecheck + vitest + Playwright
headless (happy path **và** edge case) + kiểm console errors + `check-view-invoker`
cho mọi migration đụng view.

⇒ Kế hoạch không có cut line sẽ bị bỏ dở sau Giai đoạn 1 với registry xây một nửa —
**trạng thái tệ nhất**, vì một registry điền dở còn kém tin cậy hơn một danh sách
hard-code trung thực. §13 cần kết bằng một câu "ship G1 + các xoá rẻ, rồi **đánh giá
lại** xem G2–G5 có còn đáng làm không".

#### `check-view-invoker` đang nằm sai giai đoạn

§9 G3 có checkbox `node scripts/check-view-invoker.mjs`, nhưng **G4 mới là nơi tạo
view/RPC** (4 read model mới) — và checklist G4 **chỉ có** `reconcile-money.mjs`.
`CLAUDE.md` ghi án lệ: `CREATE OR REPLACE VIEW` làm rớt `security_invoker=true` → lộ
dữ liệu tenant khác.

⇒ Rủi ro hậu quả cao nhất của cả kế hoạch là **rò rỉ cross-tenant sinh ra trong lúc
đi tối ưu**, mà bài test duy nhất bắt được nó (§9 G6 "Test hai browser contexts khác
tenant") lại chạy **sau 2 giai đoạn**. Phải: (a) thêm `check-view-invoker` vào G4, và
(b) kéo test cross-tenant lên **ngay sau RPC đầu tiên**.

#### Xung đột với việc đang dang dở

Nhánh hiện tại `feat/thu-chi-dot5-6-20260729` còn **Đợt 5 (phiếu hoá đơn)** và **Đợt 6
(chốt sổ)** — cả hai nằm đúng trên `income_expenses`/`invoices`, tức Tier A của G3 và
mục tiêu read-model của G4. Cây làm việc còn có sửa đổi chưa commit ở
`useRealtimeDataSync.ts`, `useMyPermissions.ts`, `useIsAdmin.ts`.

⇒ Cần ràng buộc thứ tự tường minh: **làm G1 + các xoá rẻ NGAY** (chỉ đụng
customers/picker + 1 dòng của hub), **hoãn G3/G4 cho tới khi Đợt 5–6 hạ cánh**.

### 15.6. Lát cắt đầu tiên đề xuất thay thế

Gộp trong **1 PR, ~1 ngày, không cần Giai đoạn 0**, đo bằng đúng 1 spec Playwright:

1. **Thêm `skipLocationEnrichment` cho `useCustomers`**, early-out khối enrichment
   ([:148-187](../../src/hooks/useCustomers.ts)), truyền từ picker → **giết 7/8 request**.
   ⚠ **Bẫy:** giữ nguyên query key `["customers", undefined, undefined]`, **đừng tạo
   root mới** (vd `["customers-picker"]`) — root mới sẽ **rơi ra ngoài** `SYNC_TABLES`
   của hub và tạo đúng loại lỗ hổng mà §4.3 đang liệt kê. An toàn vì key này không
   chia sẻ với `CustomersPage`/`CustomersMobilePage`/`VehicleFormDialog`.
2. **`onCreated(customer)` + `setQueryData` vào đúng key picker.** Auto-select
   **đã có sẵn** ([`CustomerSelectionDialog.tsx:65-80`](../../src/components/contracts/CustomerSelectionDialog.tsx)
   diff theo `knownIdsRef`) nên chỉ cần dòng mới xuất hiện là selection tự chạy.
   Mẫu copy: `useBuildings.ts:249-271`.
3. **Sửa nuốt lỗi insert vehicles** (`useCustomers.ts:308`) — 1 dòng.
4. **Thêm maxWait cho debounce** (~6 dòng) — hết starvation business-performance.
5. **Bỏ `count:'exact'` ở picker** (hoặc `estimated`) — ~2,2× trên đúng query đó.
6. **Sửa `pageSize: 500` → dùng search server-side** ở `VehicleFormDialog` — hết cắt
   khách thứ 501.

*(Mục "DROP 5 bảng `network_*`" đã gỡ 2026-08-11 — ngoài phạm vi, xem banner đầu tài liệu.)*

Lát cắt này đạt **cả 3 tiêu chí thành công mà chính §13 đặt ra**, cộng thêm một fix
mất-dữ-liệu-im-lặng và một fix starvation, với **0 abstraction mới, 0 migration, 0
observability phải xây trước**.

### 15.7. Xếp lại Giai đoạn 4 theo tỉ lệ ăn/công

| Thứ tự đề xuất | Hạng mục | Lý do |
|---:|---|---|
| 1 | Bỏ `count: 'exact'` khỏi list | đo được ~2,2×, đổi 1 dòng |
| 2 | Thu hẹp cột (`select *` → danh sách cột) ở invoices list | shape mới là nút thắt, không phải khối lượng |
| 3 | Index trigram cho ILIKE (`pg_trgm` **đã cài sẵn** trên prod) | search là shape đắt nhất đo được |
| 4 | Compact read model cho picker/list | tái dùng mẫu `THU_TIEN_SELECT` + `useInvoiceItemsLite` đã có ở luồng `/thu-tien` |
| 5 | Giảm write amplification `invoices` (664k row-version) | driver thật của fan-out |
| — | ~~Cursor pagination~~ | **bỏ** — 903 dòng, offset không suy giảm; xâm lấn nhất, lợi ích ~0 |
| — | ~~Tối ưu `can_access_org_entity`~~ | **bỏ** — đã làm ở `20260726130000` |

### 15.8. Tổng kết

**Giữ:** §3 (root cause local-first — đúng và đã verify từng dòng), §4.3 (lỗ hổng
dependency), §4.5 (echo), §5.1 (shape query nặng), §8.1 (local command path).

**Sửa:** §4.1 (17 bảng), §4.7 (viết lại — notifications đã production-ready và là mẫu
tham chiếu), §5.3 (nâng lên High, 143 version vắng sổ, đảo chiều rủi ro), §2 (nhãn dòng
`setQueryData`), §8 (nói rõ quan hệ với `realtime-sync.md`).

**Bỏ:** §9 G4 dòng 472 (RLS — đã xong), §9 G5 "intent-based prefetch" (đã có), §9 G5
Broadcast (11 user — định cỡ sai), §9 G4 cursor pagination (903 dòng).

**Thêm:** WAL poller 25,5% DB time; debounce starvation;
DELETE bypass RLS; org filter giết DELETE; `realtime.messages` 0 policy; `count:'exact'`
2 lần InitPlan; multi-tab; 3 bug im lặng ở `useCustomers`/`VehicleFormDialog`.

**Đảo thứ tự:** Giai đoạn 1 (+ 5 fix rẻ) **trước** Giai đoạn 0, và thay KPI percentile
bằng phép đo tổng hợp Playwright.

---

## 16. Audit lại theo hệ thống hiện tại (2026-08-11)

> Nối vào cuối, **không sửa §1–§15**. Cùng lý do §15 đã nêu: hai bản của một khẳng
> định sẽ lệch nhau rồi không ai biết bản nào đúng.
>
> **Mốc đo**: commit `874694f7`, nhánh `main`, 2026-08-11 — **575 commit** sau bản
> audit gốc. DB đọc qua Management API, project `tryymsxyyckgbrmmvozx`, chỉ SELECT.
>
> Câu hỏi của phiên này không phải "bản kế hoạch có đúng không" (§15 đã chấm 87
> khẳng định) mà là **"sau 13 ngày, còn gì đáng làm"**. Ba nhóm kết quả: còn đúng
> nguyên, đã được làm xong, và — nhóm nguy hiểm nhất — **§15 nay đã sai**.

### 16.1. Vì sao phải audit lại chính bản audit

§15 tự đặt bài học: *"mọi con số phải ghi kèm commit và lệnh đo"*. Bài học đó đúng
và đây là bằng chứng: **4 trong 15 phát hiện của §15.4 nay đã hết hiệu lực**. Một
trong số đó nguy hiểm tới mức phải gỡ hẳn khỏi tài liệu (xem banner đầu trang); một
mục khác — §15.3 "phải khôi phục sổ ghi migration cho 143 version" — nay đề xuất
làm ngược lại điều repo đã cố ý chọn, và thi hành nó sẽ phá chính bất biến mà
`check-migration-ledger-frozen.mjs` sinh ra để canh.

Một tài liệu audit không có ngày hết hạn thì phần "đề xuất" của nó tiếp tục được
đọc như lệnh, rất lâu sau khi phần "đo đạc" của nó đã chết.

### 16.2. Còn đúng nguyên — kiểm lại từng dòng

| Khẳng định | Nơi kiểm hôm nay | Trạng thái |
|---|---|---:|
| §3.2 picker dùng trọn `useCustomers` | `CustomerSelectionDialog.tsx:45` | còn |
| §3.2 `CreateCustomerDialog` không có `onCreated` | `:88–93` chỉ `open`/`onOpenChange` | còn |
| §3.2 `select("*", { count: "exact" })` | `useCustomers.ts:90` | còn |
| §3.2 enrichment chunk 80, vòng `for` tuần tự | `useCustomers.ts:150–180` | còn |
| §3.2 `onSuccess` bỏ `data` | `useCustomers.ts:313–318` | còn |
| §4.5 không có echo suppression | grep `suppress`/`mutationOrigin`/`clientId` = **0** | còn |
| §4.6 `subscribe()` không callback trạng thái | `useRealtimeDataSync.ts:152` | còn |
| §15.4 #3 debounce không `maxWait` | `:140–148` | còn |
| §15.4 #3 một timer chung cho 5 bảng | `:115–133` | còn |
| §15.4 #12 `hubActive` là biến module | `:102`, `:110` (nhánh sớm vẫn không trả cleanup) | còn |
| §15.4 #6 `realtime.messages` **0 policy** | `pg_policies where schemaname='realtime'` → 0 | còn |
| §15.4 #7 `count:'exact'` | **13 chỗ**, gồm cả 4 list gốc | còn |
| §15.4 #14 hai hook junction hard-delete | `useContracts.ts:702`, `:752` | còn |
| §15.4 #15 nuốt lỗi insert vehicles | `useCustomers.ts:308` | còn |
| §15.5 **0 hạ tầng telemetry** | `package.json` sạch; `performance.mark` = 0 | còn |
| §5.1 search ILIKE lệch index | `idx_customers_search` vẫn GIN `to_tsvector`; `useCustomers.ts:114` vẫn ILIKE | còn |

Đo lại §5.1 trên `pg_stat_statements` hôm nay: invoices list **635 / 930 / 1.210 /
1.592 ms**, contracts **353 → 1.363 ms**, vehicles **435 ms**. Trùng khít bảng cũ —
shape chưa đổi thì số không đổi.

Hai đính chính nhỏ trong nhóm này:

- **§4.6 đúng về bản chất, sai về số đếm sau khi thu hẹp phạm vi.** Trong phạm vi kế
  hoạch nay có đúng **2** chỗ `.subscribe()` — `useRealtimeDataSync.ts:152` và
  `useNotifications.ts:360` — và **không chỗ nào** có callback trạng thái. Bản audit
  ghi "0/4" vì đếm cả hai channel Zalo; con số đúng hôm nay là **0/2**. Kết luận
  không đổi: mất realtime là mất im lặng, không log, không cách nào biết.
- **§3 có một fix ngoài kế hoạch đã ship**: picker nay gate bằng `enabled: open`
  (`CustomerSelectionDialog.tsx:45`, `useCustomers.ts:74–80`). Trước đó dialog
  mounted-sẵn kéo cả bảng customers + chuỗi enrichment **mỗi lần tải `/contracts`
  dù chưa ai mở form**. Đây là phần tốn kém nhất của §3.1 mà bản audit không nêu.

### 16.3. Đã làm xong — phải xoá khỏi kế hoạch

#### §9 G2 "typed query dependency registry" — ĐÃ TỒN TẠI

Đây là hạng mục lớn nhất của kế hoạch (8 checkbox) và nó đã được xây, bằng một hình
dạng khác nhưng phục vụ đúng mục đích:

- Descriptor **tách theo miền**: `src/hooks/realtime/{finance,contracts,operations}.ts`,
  kiểu chung ở `types.ts`, gom ở `index.ts`.
- `src/lib/realtime/syncTables.ts` là **module dữ liệu thuần** (không import React)
  để script gate đọc được.
- Hub còn **168 dòng**, chỉ mở channel / gom debounce / điều phối.

Bốn gate chạy hôm nay, tất cả xanh:

```text
check-realtime-descriptors   hub 13 bảng ⊂ publication 30 bảng
check-realtime-query-keys    58 key trong descriptor đều có query thật dùng
check-realtime-key-ownership 150 gốc key bắn vào · 237 gốc app dùng · 0 bắn trượt
check-realtime-surface       0 subscribe câm · 0 trôi
```

Ba checkbox cuối của G2 ("test kiểm mọi query source có dependency mapping",
"test ngăn query root mới bị bỏ sót") **chính là bốn gate này**. Test hub:
**33/33 pass** (24 + 6 + 3), so với 23 lúc audit.

> **Nhưng một chiều vẫn hở**, và đúng chiều mà §15.6 cảnh báo: các gate kiểm
> *"key được bắn vào có ai nhận không"*, **không** kiểm *"query root mới có ai bắn
> vào không"*. Tạo `["customers-picker"]` hôm nay vẫn rơi ra ngoài hub mà không gate
> nào đỏ. Cảnh báo của §15.6 mục 1 vẫn phải đọc.

#### §4.3 — phần lớn lỗ hổng dependency đã bịt

Publication nay **30 bảng** (audit ghi 16, §15.3 sửa thành 17). Hub nghe 13.

| §4.3 nêu thiếu tín hiệu | Hôm nay |
|---|---|
| `payments` | ✅ publish + descriptor 7 key |
| `contract_terminations` | ✅ publish + 6 key (kèm đính chính key chết) |
| `contract_transfers` | ✅ publish + 4 key |
| `income_expense_items`, `accounts`, `cash_handovers` | ✅ publish + descriptor |
| `contract_customers`, `contract_services` | ❌ **vẫn không publish, vẫn hard-delete** |
| `vehicles`, `invoice_items`, `meters`, `meter_readings` | ❌ vẫn không publish |

`rooms`/`buildings` vẫn chỉ mang key `["business-performance"]` — nhưng nay là
**quyết định có ghi lý do** tại `operations.ts`, không còn là bỏ sót vô ý.

#### §5.3 và §15.3 — cả hai đều bị vượt qua bởi một quyết định kiến trúc

§5.3 nói "2 migration chưa apply". §15.3 lật lại: "143 version vắng sổ, phải khôi
phục sổ ghi". **Cả hai nay đều không còn là việc phải làm.**

Sổ `schema_migrations` **đông cứng có chủ ý** ở `20260727095000` / 372 dòng — đó là
mốc dự án chuyển sang **forward-only lane**. Nguồn sự thật nay là
`supabase/migration-provenance.json`:

| Trạng thái | Số entry |
|---|---:|
| `ledger-applied` | 351 |
| `catalog-proven` | 214 |
| `superseded` | 15 |
| **`unknown`** | **65** |
| tổng | 645 |

Và `scripts/check-migration-ledger-frozen.mjs` băm toàn bộ bảng để bắt bất kỳ ai
viết lại sổ. ⇒ Việc còn lại **không phải** "khôi phục 143 version" mà là **65 entry
`unknown`**. Rủi ro dựng-lại-môi-trường mà §15.3 nêu vẫn thật, nhưng nay được che
bởi baseline + `tooling/known-gaps.yaml` (`baseline-schema-khong-trong-repo`,
hết hạn 30/11/2026) chứ không còn là phát hiện mới.

#### Ba mục §15 đã chỉ ra là "đã có" — xác nhận vẫn còn

`src/lib/prefetchIntent.ts` (§9 G5), `trackConsoleErrors` (§9 G0),
`docs/he-thong/realtime-sync.md` 194 dòng (§9 G3). Tối ưu
`can_access_org_entity`/`has_any_scope_v3` (§9 G4 dòng 472) vẫn là việc đã xong từ
`20260726130000`.

#### §4.7 — notifications

Mount tại `AppProviders.tsx:56–60` cạnh `RealtimeDataSync`; `notifications` nằm
trong publication. §15.3 đã sửa; xác nhận vẫn đúng.

### 16.4. §15 nay đã SAI — ba mục

> Mục thứ tư (§15.4 ★★★2, "DROP 5 bảng `network_*`") đã được **gỡ khỏi tài liệu**
> thay vì đính chính tại chỗ — cùng lý do với banner đầu trang: một đề xuất sai nằm
> cạnh phần đính chính nó vẫn có thể bị đọc rời và đem thi hành.

#### ✗ 1. "WAL poller chiếm 25,5% thời gian DB" (§15.4 ★★★1)

Tỉ lệ hôm nay: **4,3%**. Nhưng đừng đọc thành "vấn đề đã hết" — đọc kỹ thì **kết
luận của mục đó mạnh lên**:

| | Bản audit | Hôm nay |
|---|---:|---:|
| Thời gian tuyệt đối của poller | 6,7 giờ | **15,0 giờ** (54.020 s) |
| Lượt gọi | — | 4.335.720 |
| Số bảng trong publication | 17 | **30** |

Publication gần gấp đôi, chi phí poller gấp đôi. **Tỉ lệ giảm chỉ vì mẫu số phình
ra** (xem mục kế). Luận điểm "chi phí cố định theo số bảng publish" vẫn đúng và nay
có bằng chứng hai điểm thay vì một.

#### ✗ 2. "Write amplification là driver thật" (§15.4 ★★8, §15.7 hạng 5)

`invoices.n_tup_upd`: **664.258** lúc audit → **667.106** hôm nay = **+2.848 trong
13 ngày**. Con số 664k là **nợ lịch sử của một đợt backfill**, không phải churn đang
chạy. Đề xuất "giảm write amplification `invoices`" mất phần lớn căn cứ.

Quy mô khác cũng đã đổi: **15** tài khoản (từ 11), DB **387 MB** (từ 151 MB — ×2,5
trong 13 ngày, và phần tăng gần như toàn bộ nằm ở tiểu hệ ngoài phạm vi, không phải
ở dữ liệu nghiệp vụ), invoices 1.251 dòng, customers 523.

#### ✗ 3. "Cross-tenant event/data leak hiện KHÔNG đạt" (§15.4 ★★★4)

Phải **phát biểu lại**, và repo đã tự làm việc đó:
`src/hooks/__tests__/realtimeTenantBoundary.test.ts` ghim đúng hiện trạng với lập
luận đúng — hub bỏ payload hoàn toàn, mọi refetch đi qua RLS ⇒ **không rò dữ liệu**.

Cái thật sự rò với replica identity DEFAULT + không filter là **khoá chính và thời
điểm** của một DELETE ở org khác, cộng **refetch thừa**. Đó là rò *siêu dữ liệu* và
*chi phí*, không phải rò *dữ liệu*. KPI §10 dòng cuối nên tách làm hai; gộp một dòng
thì hoặc bị tuyên bố đạt sai, hoặc bị coi là không bao giờ đạt được.

`check-realtime-surface` nay tự cảnh báo: **30/30 bảng REPLICA IDENTITY = DEFAULT**.

### 16.5. Cái mới — không có trong cả §1–§14 lẫn §15

#### ★★★ Query list của CRM nay chỉ chiếm ~0,6% thời gian DB

Đo `pg_stat_statements` (tích luỹ từ 25/04/2026), gộp theo phạm vi:

| Nhóm | % tổng thời gian thực thi |
|---|---:|
| RPC của các tiểu hệ **ngoài phạm vi** kế hoạch này | **≈84,6%** |
| WAL poller (chi phí realtime, xem ✗1) | 4,3% |
| **invoices + contracts + vehicles list — thứ §9 G4 định tối ưu** | **≈0,6%** |

Hệ quả trực tiếp cho kế hoạch: **§9 G4 "compact read model" nhắm vào ~0,6% tải
database.** Ba hạng mục đầu của §15.7 vẫn đáng làm — chúng rẻ, và chúng chữa **thời
gian chờ của người dùng**, thứ mà bảng trên không đo. Nhưng đừng bán chúng như một
đợt tối ưu hiệu năng hệ thống: nếu mục tiêu là giảm tải DB thì chúng nằm sai chỗ hai
bậc độ lớn, và phần lớn tải đó **không thuộc thẩm quyền của kế hoạch này**.

Một hạng mục đáng chú ý nằm ngay ranh giới: **`get_authorization_context_v1` chiếm
12,1% (375.602 lượt × 402 ms ≈ 42 giờ)**. Đây là RPC uỷ quyền dùng chung, nhưng số
lượt bám 1:1 theo lưu lượng của một tiểu hệ ngoài phạm vi — nên nó **không phải**
"RLS helper đắt" mà §6/§9 G4 nói tới, và cũng không sửa được từ trong kế hoạch này.
Ghi lại để không ai đọc con số 12,1% rồi mở lại checkbox RLS đã đóng từ 26/07.

> **Ranh giới**: đoạn trên **chỉ là số đo đọc từ `pg_stat_statements`**. Không đọc mã,
> không chạy test, không đụng dữ liệu của các tiểu hệ ngoài phạm vi, và không đề xuất
> sửa gì trong đó.

#### ★★★ `pageSize: 500` nay cắt **20 khách**, không phải 1

`select count(*) filter (where deleted_at is null) from customers` → **520**.
`VehicleFormDialog.tsx:94–98` vẫn `{ page: 1, pageSize: 500 }` ⇒ `.range(0,499)`
**bỏ im lặng 20 khách gần nhất**. Lúc audit là 501/500 (mất 1). Cùng một dòng mã,
mức thiệt hại đã ×20 trong 13 ngày — đúng dạng lỗi mà §15.4 #15 gọi là "mất dữ liệu
im lặng cách 2× tăng trưởng", nay đã tới.

`CustomerSelectionDialog` vẫn không truyền pagination ⇒ vẫn dựa vào PostgREST
`max_rows = 1000`. Ở 520 khách chưa chạm trần; đây là **lỗi có hẹn giờ**, không phải
lỗi đang chạy.

### 16.6. Lát cắt đầu tiên — bản 11/08

§15.6 đề xuất 7 mục. Sau khi thu hẹp phạm vi còn **6 mục, cộng 1 mục mới**:

| # | Việc | Trạng thái |
|---:|---|---|
| 1 | `skipLocationEnrichment` cho `useCustomers`, truyền từ picker → giết 7/8 request | giữ. ⚠ cảnh báo "đừng tạo root mới" **vẫn phải đọc** — gate hiện có không bắt chiều này |
| 2 | `onCreated(customer)` + `setQueryData` đúng key picker; mẫu `useBuildings.ts` | giữ (auto-select đã sẵn ở `CustomerSelectionDialog.tsx:65–80`) |
| 3 | Sửa nuốt lỗi insert vehicles `useCustomers.ts:308` — **1 dòng** | giữ |
| 4 | `maxWait` cho debounce (~6 dòng) | giữ |
| 5 | Bỏ `count:'exact'` ở picker | giữ |
| 6 | `pageSize: 500` ở `VehicleFormDialog` | giữ, **ưu tiên cao hơn** — đang mất 20 khách |
| 7 | *(mới)* Gắn callback trạng thái cho **2 channel trong phạm vi** (hub, notifications) | thêm — đóng đúng §4.6 |

*(Mục "DROP 5 bảng `network_*`" của §15.6 đã gỡ — ngoài phạm vi.)*

Vẫn **0 abstraction mới, 0 migration, 0 observability phải xây trước**. Kết luận
"Giai đoạn 1 trước Giai đoạn 0" của §15.5 giữ nguyên: repo vẫn có **0 hạ tầng
telemetry**, nên Giai đoạn 0 vẫn là một dự án riêng chứ không phải bước chuẩn bị.

### 16.7. Tổng kết trạng thái kế hoạch

| Giai đoạn | Trạng thái 11/08 |
|---|---|
| G0 instrumentation | chưa bắt đầu; vẫn nên **hoãn**, không phải làm trước |
| G1 flow tạo khách | **chưa làm gì** ngoài `enabled: open`; vẫn là lát cắt đầu |
| G2 registry | **về cơ bản đã xong** — descriptor theo miền + 4 gate; còn hở chiều "root mới" |
| G3 realtime Tier A | **quá nửa** — 6 bảng nghiệp vụ mới có tín hiệu; còn `contract_customers`/`contract_services`/`vehicles`/`invoice_items`/`meters` |
| G4 read model + DB tuning | RLS **đã xong từ 26/07**; cursor pagination **nên bỏ**; read model nay chỉ chạm ~0,6% tải DB |
| G5 health/reconnect | chưa; Broadcast vẫn **0% hạ tầng** (`realtime.messages` 0 policy) — vẫn nên hoãn |
| G6 E2E đa ngữ cảnh | chưa; ranh giới tenant nay có test đơn vị ghim hiện trạng |

**Điều nguy hiểm nhất của tài liệu này hôm nay không phải phần chẩn đoán sai — mà là
phần đề xuất đúng-lúc-viết đang được đọc như lệnh còn hiệu lực.** Đề nghị: mọi lát
cắt lấy từ đây phải **đo lại tại commit hiện tại trước khi thi hành**. Đó cũng là lý
do mục `network_*` được gỡ hẳn thay vì để lại kèm đính chính — xem banner đầu trang.
