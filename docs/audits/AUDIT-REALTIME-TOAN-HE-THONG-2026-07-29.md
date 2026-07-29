# Audit realtime toàn hệ thống và kế hoạch tối ưu

> Ngày audit: 2026-07-29  
> Phạm vi: React/TypeScript, TanStack Query cache, Supabase Realtime, Postgres/RLS, migrations và các flow nghiệp vụ liên quan  
> Production đối chiếu: <https://ptcrm.vercel.app>  
> Trạng thái: tài liệu audit và đề xuất kiến trúc; chưa triển khai thay đổi code hoặc database

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

Production hiện có 16 bảng trong publication realtime:

- Business: `buildings`, `contracts`, `customers`, `income_expenses`, `invoices`, `jobs`, `rooms`.
- Zalo: 4 bảng.
- Network center: 5 bảng.

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

**Tác động:** UI chậm, request thừa, tải tăng theo quy mô dữ liệu.  
**Bằng chứng:** flow tạo khách mất 943–1.918 ms dù POST chỉ 171 ms.  
**Root cause:** mutation response không được đưa vào cache/state.  
**Hướng sửa:** local-first mutation response, auto-select và background reconciliation.

### Critical — Dependency graph realtime không đầy đủ

**Tác động:** client khác có thể giữ dữ liệu cũ ở contracts, invoices, vehicles, rooms/buildings và junction-dependent screens.  
**Root cause:** query-key mapping hard-code theo bảng.  
**Hướng sửa:** typed dependency/domain registry và parent/domain signals.

### High — Không có reconnect/catch-up protocol

**Tác động:** tab ngủ hoặc websocket lỗi có thể giữ cache stale vô thời hạn.  
**Root cause:** không theo dõi channel status, không version check, `refetchOnWindowFocus` bị tắt.  
**Hướng sửa:** health state, reconnect handling và catch-up active queries/domain version.

### High — Same-client realtime echo gây duplicate refetch

**Tác động:** tăng network/DB load và có thể làm danh sách nặng chậm thêm.  
**Root cause:** không có mutation-origin dedupe/suppression.  
**Hướng sửa:** client/mutation ID hoặc suppression window theo entity/domain.

### High — Event-driven eager prefetch quá rộng

**Tác động:** invoices/contracts query nặng được tải nền dù user không dùng.  
**Root cause:** mọi visible tab đều có thể `prefetchDomain` sau event.  
**Hướng sửa:** active-query only, stale-only cho cache không active, intent-based prefetch.

### High — Read models quá nặng

**Tác động:** list queries có mean từ 0,8 đến hơn 2 giây.  
**Root cause:** `select *`, exact count, nested relations, lateral embeds và supplemental RPC.  
**Hướng sửa:** compact list RPC/view, cursor pagination, lazy detail và query-specific indexes.

### High — RLS helper đắt đối với realtime fan-out

**Tác động:** throughput giảm theo số subscriber, không chỉ theo write rate.  
**Root cause:** authorization helper phức tạp và nhiều shared block hits.  
**Hướng sửa:** set-based/indexed lookup, cached initplan và benchmark với JWT thật.

### Medium — Publication/migration drift

**Tác động:** production và môi trường dựng lại có thể hoạt động khác nhau.  
**Hướng sửa:** reconciliation migration, audit `schema_migrations` và publication trong CI/deploy verification.

## 7. Các phương án kiến trúc

### Phương án A — Publish Postgres Changes cho mọi bảng

**Ưu điểm:** triển khai ban đầu nhanh, ít abstraction frontend.  
**Nhược điểm:** RLS authorization nhân theo subscriber, DELETE khó filter, fan-out cao, dễ tạo bão invalidate.  
**Đánh giá:** không khuyến nghị cho toàn hệ thống.

### Phương án B — Polling/refetch thuần

**Ưu điểm:** dễ hiểu, ít phụ thuộc websocket.  
**Nhược điểm:** tốn bandwidth, dữ liệu có độ trễ và không tạo cảm giác tức thì.  
**Đánh giá:** chỉ phù hợp làm fallback/catch-up cho một số màn.

### Phương án C — Hybrid local-first + domain signal

**Ưu điểm:** cùng client tức thì, cross-client đủ nhanh, kiểm soát được query load và scale tốt hơn.  
**Nhược điểm:** cần dependency registry và mutation discipline rõ ràng.  
**Đánh giá:** phương án khuyến nghị.

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

