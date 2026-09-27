# Phòng sale, nhắc trả phòng và dọn/sửa — bằng chứng cho plan

Ngày rà: 27/09/2026. Base: `e498f10d49f3548e72074095c955371d0cee41ab`.
Phạm vi: đọc source; chỉ viết báo cáo này, không sửa app/SQL, không đọc vault hay gọi production.
Các neo `file:dòng` dưới đây tính từ gốc worktree ở SHA trên. Migration
`20260528000007_drop_beds_fix_rpcs.sql` đã có thay đổi trước phiên; chỉ đọc bản `git show HEAD:…`,
không dùng working copy đó làm căn cứ. “Hiện tại” nghĩa là source checkout, chưa phải catalog sống.

## 1. Quyết định và giới hạn

Yêu cầu đã chốt: báo ngày dự kiến không kết thúc cư trú; chỉ xác nhận đã rời mới nhả phòng.
Phòng **đã trả nhưng đang dọn/sửa vẫn báo trống để sale**, kèm ngày nhận dự kiến. Dọn trễ
vẫn sale, chuyển nhãn ngày nhận thành “Cần xác nhận” và nhắc quản lý. Không tạo gate
`MAINTENANCE` cho inventory từ công việc này. Cọc giữ chỗ/hold của khách kế phải được giữ.

Nhắc trước một ngày, đúng ngày, quá hạn là **đề xuất**. Công việc xử lý không biến mất khi đọc
thông báo; chỉ xác nhận rời, dời lịch hoặc hủy báo mới giải quyết phiên nhắc tương ứng.
Với ngày dự kiến đã qua nhưng chưa xác nhận khách đi, không tiếp tục quảng cáo ngày cũ.
Phương án tạm rút khỏi danh sách chào khách trong HTML là đề xuất cần review, không phải
quyết định đã triển khai. Các RPC/schema mới dưới đây cũng chỉ là thiết kế để audit.

## 2. Projection phòng sale đang có

Hai reader đầy đủ gần nhất tìm được là `get_my_available_rooms()` và
`get_public_available_rooms(text)` trong
`supabase/migrations/20260731070000_current_date_to_org_today.sql:2471,2657`.
Reader public kiểm token chưa thu hồi, suy `owner_id` (`:2673`); reader đăng nhập suy owner
từ `staff_assignments LIMIT 1` (`:2488`). Đây không phải bằng chứng đã có scope org/toà chính
xác theo lựa chọn UI; trước thay đổi phải đối chiếu catalog, ACL, token có `organization_id`
và tài khoản nhiều org. Không mở rộng scope để làm revision chung cho mọi owner.

Thứ tự CASE public ở `:2710` là **pass → cọc giữ chỗ → sắp trống → còn HĐ → AVAILABLE**.
Vì pass đứng đầu, tin pass đang active có thể thắng hold. `:2722–2754` nhận ngày dự kiến
trong cửa sổ `soon_days`, nhưng còn OR với ngày kết thúc hợp đồng: báo trả quá hạn có thể
rơi về ngày hết hạn tương lai. Không có trạng thái “đã trả, chờ dọn” riêng. Payload cũng
chứa phòng `rented` của toà có ít nhất một phòng sale (`:2766–2772`); “tạm rút” cần định
nghĩa là không chào bán/không có ngày nhận, hay loại hẳn payload, tránh nhầm với lọc UI.

Hold không chỉ là `rooms.status`. Helper `room_has_holding_deposit` được patch ngày 09/09
để bỏ cọc giữ chỗ đã quyết toán:
`supabase/migrations/20260909172332_reservation_deposit_settlement_v1.sql:606–609`.
Còn hold tạm `room_reservation_holds` chặn ký mới tại
`20260721090000_contract_create_v2.sql:571–584`. Phải kiểm cả hai cơ chế, không tự gộp nháp
thành hold. Migration restore 21/09 không phải lý do bỏ patch giữ chỗ 09/09 này.

UI có bốn nhãn `free/soon/pass/rented`; `src/pages/phong-trong/supabaseData.ts:166` chỉ giữ
`availDate` khi `soon`. `PhongTrongParts.tsx:81` và `PhongTrongSheet.tsx:345` chỉ vẽ ngày
ở nhánh sắp trống; copy tin và ảnh xuất cũng cần nhận ngày dự kiến của phòng đã trả.
Không đổi phòng dọn/sửa thành `soon` chỉ để tận dụng nhãn, vì nó đã trống về cư trú.

Theo [master plan](../../superpowers/plans/2026-09-27-contract-lifecycle.md) §5.1, đề xuất
`app_private.room_sale_facts_v1(room_id, as_of timestamptz)` dùng chung, hai wrapper giữ
quyền riêng. Payload thêm `arrival_status`, `estimated_ready_on`, `availability_updated_at`;
không trả contract/job/khách thuê. Scope và claim thắng pass; pass ACTIVE hợp lệ vẫn được
chào theo D08, không dùng ngày trả quá hạn. Không có pass hợp lệ mới xét notice/cư trú;
hủy/quá hạn không fallback `end_date`. Đã trả dùng turnover đúng lần trả: dọn trễ là
`free + NEEDS_CONFIRMATION`, không thành `rented`. Public contact theo allowlist và cấu
hình/chấp thuận hiện hành; không lấy tenant làm fallback. Phòng bị khóa vì lý do ngoài
turnover giữ chính sách cũ. D02/D08 vẫn là đề xuất chờ duyệt.

## 3. Công việc có thể tái sử dụng

`jobs` đã có `building_id`, `room_id`, `assignee_id/name`, `deadline timestamptz`, attachments
và completion fields: `src/hooks/useJobs.ts:45`, `src/types/jobs.ts:42`.
Trạng thái UI chỉ `IN_PROGRESS/COMPLETED` (`types/jobs.ts:2`); không giả định có CANCELLED.
Danh sách cố ý giữ mọi việc mở ngoài cửa sổ 90 ngày (`useJobs.ts:27,113`), phù hợp overdue.
`src/lib/jobValidation.ts:95` tính quá hạn từ deadline và trạng thái, không từ READ.

Jobs nuôi lương. `20260720140000_jobs_exclude_from_salary.sql:25` có cờ loại khỏi lương;
`20260720181000_jobs_completion_time_integrity.sql:59` đóng dấu giờ hoàn thành phía server.
Notice dùng `lifecycle_work_items`, không sinh jobs hành chính theo từng phase. Job dọn/sửa
TRACKING phải được DB giữ `exclude_from_salary=true`; generic patch không mở lại payroll.
Job trả công hiện hữu chỉ liên kết APPROVED_PAID_JOB theo quyền/policy lương đã duyệt.

Neo cần bổ sung ở P3: `TaskCompleteDialog.tsx:121,130` gọi cả bonus và V5 attendance sau
hoàn tất. `20260720190000_v5_date_hardening.sql:134–143` chỉ kiểm COMPLETED/assignee/ảnh,
không kiểm exclude flag trước `v5_tick_attendance`. `20260720181000_jobs_completion_time_integrity.sql:368,400`
cũng tạo JOB/DAY_BONUS notification mà không kiểm flag; migration exclude `:17–19` ghi rõ
đã để popup ngoài phạm vi. Do đó phải chặn TRACKING trên cả hai RPC này, không chỉ ledger
hay generic update. Test direct RPC và UI không tăng attendance/phụ cấp/popup cho TRACKING;
APPROVED_PAID_JOB giữ policy. Đây là source finding, chưa xác minh catalog sống.

SELECT jobs theo scope toà tại `20260726130000_rls_setbased_missed_tables.sql:81`;
ghi theo `tasks.create/edit/delete` tại `20260725200000_cutover_policies_array_form.sql:333`.
Được gán việc không tự đồng nghĩa được sửa hợp đồng. Cần RPC hoàn tất công việc nguồn
với kiểm quyền và membership còn hiệu lực; không dùng `.update({status,...extraData})`
chung tại `useJobs.ts:179` để cho phép xác nhận khách đi qua cửa khác.

Thiết kế canonical: `room_turnover_jobs` liên kết một/nhiều jobs dọn/sửa với turnover;
jobs giữ assignee/deadline/bằng chứng. Notice và reminder đọc `lifecycle_work_items`.
Dời/hủy/xác nhận rời đóng hoặc supersede item đúng revision, không dùng jobs.COMPLETED
làm đóng kỹ thuật notice. Hoàn tất job không tự kết thúc cư trú hay xác nhận turnover
READY. Có thể liên kết notification tới work-item để mở đúng nguồn; đó không phải hàng
việc hay scheduler thứ hai. Không sửa semantics của job thủ công hiện hữu.

## 4. Schema/API đề xuất để reviewer phản biện

Master plan §3/§4 là hợp đồng đề xuất duy nhất; phần rút gọn dưới đây cùng tên và trạng
thái, không phải schema/API song song. Cột `contracts.expected_move_out_date` chỉ là
projection tương thích, cập nhật nguyên tử từ notice.

```text
contract_moveout_notices: id, organization_id, building_id, contract_id, room_id,
  expected_on DATE, status OPEN|FULFILLED|CANCELLED, revision BIGINT,
  responsible_membership_id, created_by, created_at, updated_at, resolved_at;
  UNIQUE active notice per contract; composite scope FKs
contract_lifecycle_events: append-only before/after, entity_version, event_type,
  actor_membership_id, reason, occurred_at, operation_id; scope per master §3.2
room_turnovers: id, organization_id, building_id, room_id, exit_case_id UNIQUE,
  status PENDING|READY, expected_ready_on DATE NULLABLE,
  responsible_membership_id, version, completed_at NULLABLE
room_turnover_jobs: turnover_id, job_id UNIQUE, organization_id,
  classification TRACKING|APPROVED_PAID_JOB; composite scope checks
lifecycle_work_items: id, organization_id, building_id, source_kind, source_id,
  source_revision, kind NOTICE_TOMORROW|NOTICE_DUE|NOTICE_OVERDUE|
    TURNOVER_DUE|TURNOVER_OVERDUE, due_on, status OPEN|RESOLVED|SUPERSEDED,
  responsible_membership_id, snoozed_until, resolved_at, last_notified_on;
  UNIQUE(source_kind, source_id, source_revision, kind);
  partial UNIQUE(source_kind, source_id, source_revision) WHERE status=OPEN
notification outbox: UNIQUE(work_item_id, recipient_membership_id, local_day)
app_private.availability_scope_versions: scope_id, revision BIGINT; no anon SELECT
```

Lưu ngày dự kiến dưới dạng `date`; giờ chạy, audit và lease là `timestamptz`. Schema mới có
FK và constraint đảm bảo org/room/contract của liên kết khớp nhau; RLS không dựa vào ID
client tự khai. Lưu revision cả khi đổi assignee để dispatcher không gửi cho người cũ.
Nguồn thật của “đã trả” là exit case/lifecycle đã commit theo master, không phải job bấm xong.

```text
set_contract_moveout_notice_v1(p_input jsonb)
cancel_contract_moveout_notice_v1(p_input jsonb)
confirm_contract_moveout_v1(p_input jsonb) # master sở hữu transaction nhả phòng
update_room_turnover_v1(p_input jsonb)    # status/date/assignee/reason/version
app_private.sweep_contract_lifecycle_work_v1(p_as_of timestamptz)
get_available_rooms_revision_v1(p_token text) -> {
  scopeEpoch: opaque, revision: string, orgToday: date,
  nextTransitionAt: timestamptz|null, serverNow: timestamptz }
# Commands: operationId + expectedVersion string, typed payload theo master §4.1.
# Sweep chỉ scheduler role; test clock không qua public RPC production.
```

Writer khóa nguồn, so revision, ghi audit và đóng/supersede work-item/outbox cùng transaction;
lỗi audit phải rollback. Xác nhận đã rời đóng notice và mở turnover, không đợi tạo job
có đủ assignee. Nếu chưa xác định người nhận: tồn việc trong hàng đợi quản lý kèm lỗi rõ.
Đổi ngày sẵn sàng, hoàn tất dọn hay quyết toán không đụng hold khách kế/contract mới.
Job của turnover cũ được hoàn thành muộn cũng không ghi đè turnover hiện hành của room.

## 5. Nhắc nền: khoảng trống hiện tại

`useScheduledNotifications.ts:14,38` gate localStorage khoảng 20 giờ, đánh dấu trước khi
chạy và lặp mỗi 6 giờ; chỉ mount ở `src/pages/Dashboard.tsx:60`.
`notificationScheduler.ts:38` nhắc hết hạn HĐ, không phải báo trả phòng; dùng đồng hồ
browser và query `user_id`. Không thể dùng nó để cam kết chạy khi không ai mở app.

Có `scheduled_jobs` (`029_missing_features.sql:393`) nhưng chỉ thấy cấu hình/lịch sử
schema và types; chưa tìm thấy consumer thực thi trong source app/Edge. Sự tồn tại bảng
không chứng minh scheduler đang chạy. `cron_runs` có unique `(job,idem_key)` ở
`20260703000001_v5_foundation.sql:98`; `v5_cron_start` insert-conflict bỏ lượt trong
`20260703000003_v5_jobs.sql:10`. Edge `salary-v5-jobs/index.ts:152` bắt đầu trước thực thi,
nên chép nguyên cơ chế đó có thể làm lần lỗi đầu khóa retry cùng ngày.

`vercel.json:81` khai hai cron salary; Edge chỉ nhận các job trong nhánh `:255–278`.
Có pg_cron trong các migration khác, nhưng comment legacy “không pg_cron” không phản ánh
toàn repo. Không suy cấu hình triển khai từ comment hoặc thêm lịch Vercel thứ ba khi chưa
kiểm quota. Gate phát hành phải xác nhận scheduler thật trên TEST rồi đúng đích production.

Đề xuất D01 thống nhất: DB sweep idempotent mỗi 15 phút bằng pg_cron **nếu đích hỗ trợ**;
nếu không, dùng transport scheduler đã được phê duyệt gọi RPC service-only. Sweep chỉ tạo
thông báo/hàng việc, không gọi RPC trả phòng, không sinh tiền. Claim lô giới hạn có lease
và `FOR UPDATE SKIP LOCKED`; log attempt/started/finished/error và heartbeat không thay
cho dedup nghiệp vụ. Lỗi một nguồn không làm mất tất cả nguồn còn lại; nguồn lỗi còn retry
với backoff hữu hạn và hàng failed cho quản lý. Không đánh dấu cả ngày “xong” khi batch lỗi.

Mốc đề xuất: trước một ngày và đúng ngày lúc 08:00 giờ org; overdue bắt đầu ngày kế tiếp,
nhắc gộp tối đa một lần/người/ngày. Tạo/dời báo sau mốc chạy phải enqueue phase thích hợp
ngay hoặc lần sweep kế. Scheduler nghỉ nhiều ngày thì gom overdue hiện hành, không bắn
lại toàn bộ chuỗi nhắc đã lỡ. Dời/hủy/xác nhận rời cạnh tranh sweep phải khóa và kiểm lại
revision trước enqueue. Sweep xét nguồn mở lẫn item chưa đóng có nguồn đã đổi/đóng/mất;
supersede phase trước khi mở phase mới. Badge overdue độc lập READ và trạng thái gửi.

## 6. Người nhận, thông báo và push

Thông báo own-row tại `20260729130000_notifications_rls_own_row.sql:52`;
`useNotifications.ts:162` chỉ cập nhật READ. Cần giữ nguyên: đọc/xóa inbox không đóng việc.
Danh sách inbox cap 200 (`:94`) không thể làm nguồn duy nhất để đếm việc tồn.

E4 giao việc hiện có unique `(user_id,job_id)` và trigger ở
`20260729161000_notify_event_triggers.sql:49,461,628`. Trigger yêu cầu `auth.uid()!=NULL`,
không tự thông báo job sinh nền; dedup E4 cũng không đủ cho lịch nhắc nhiều revision.
Dispatcher phải enqueue rõ ràng, tách family nhắc lifecycle khỏi E4 assignment; tránh
cùng lúc hai thông báo cùng ý. Event key mới cần cập nhật validator/preferences hiện
chỉ nhận E1…E5 tại `20260729150000_notification_config_tables_rpc.sql:328`.

Chọn assignee là membership ACTIVE có scope toà và quyền công việc tương ứng; default
quản lý toà phải được resolve phía server, không lấy người tạo hoặc tên tự do làm quyền.
Nếu không còn người hợp lệ, báo hàng “Chưa phân công” cho owner/manager có quyền thật và
ghi no-recipient; không broadcast toàn org. Kiểm quyền khi enqueue, delivery và mở deep
link; delivery đọc lại source revision/status, item cũ superseded không được phát/retry.
Nhân viên dọn chỉ nhận dữ liệu công việc, không nhận tiền/nợ hay chi tiết thuê ngoài quyền.

Reuse pipeline `notify_claim_push_batch_v1/notify_settle_push_batch_v1`:
`20260729170000_notify_push_drain_rpc.sql:130,182` có lease 15 phút, giới hạn attempt và
SKIP LOCKED. Không tự gọi nhà cung cấp push từ trigger DB. Edge `:261–269` hiện ghép drain
vào digest; chưa có bằng chứng drain đủ nhanh cho SLA mới. In-app enqueue đạt không đồng
nghĩa điện thoại đã nhận. Tách metric scheduled/enqueued/push outcome/read/resolved;
tôn trọng quiet hours và opt-out push nhưng việc tồn vẫn xuất hiện. Tránh lộ nội dung
khách/tiền trên màn khóa; default chỉ phòng, hạn và đường mở việc có kiểm quyền.

Mọi phép tính ngày dùng org rõ ràng qua `org_today_v1(org)`/`org_timezone_v1(org)`
(`20260731061000_org_timezone_today.sql:82,103`), không hardcode +07 hoặc dùng NULL trong
service sweep. Test 23:59/00:00, múi giờ org khác máy người dùng và thay timezone cấu hình.

## 7. Cập nhật danh sách và quyền riêng tư public

`usePhongTrong.ts:16` và `useMyAvailableRooms.ts:17` polling 5 phút/focus;
hub `useRealtimeDataSync.ts:140` chỉ đăng ký khi có user. `realtime/operations.ts:11`
rooms chỉ invalidate business-performance, contracts descriptor không có key availability,
còn `finance.ts:117` chỉ có `phong-trong` ở một nhánh. Không cam kết “live” hiện tại.

Đề xuất v1: authenticated nối hub theo org/toà; invalidate đúng `my-available-rooms`, rooms,
contracts, jobs và notice/turnover readers sau mutation. Key phải chứa org/actor/scope;
đổi org dọn cache và subscription. Có debounce, focus/reconnect reload; kiểm publication.

Anon **không** nhận SELECT hay postgres_changes trên contracts/jobs/notifications/events
nội bộ. Poll RPC version mỗi 5 giây khi visible; token được validate mọi lần, trả revision
bigint dạng chuỗi, orgToday, scopeEpoch và mốc snapshot; không trả org ID, room ID, người
thao tác hay loại sự kiện. Reload khi epoch/revision/day/mốc đổi hoặc tới hạn; focus/reconnect
reload ngay. Đây là
near-realtime, không phải push; mục tiêu TEST p95 ≤10 giây cần đo thực tế với hai trình duyệt.
Lỗi mạng giữ last-success với dấu dữ liệu cũ và retry backoff; token revoked/invalid phải
xóa payload đang hiển thị, không giữ phòng cũ dưới thông báo lỗi.

Version tăng trong transaction của mọi writer ảnh hưởng projection: báo/dời/hủy/đã rời,
turnover, contract mới, chuyển phòng, hold/cọc, pass, room listing/settings/token scope.
Server day bắt quá hạn dạng DATE không có DML dù cron trễ. Nếu projection xét hold có
`expires_at` giữa ngày, revision/day chưa đủ: endpoint phải trả `nextTransitionAt`
sớm nhất còn hiệu lực trong scope cùng `serverNow`; client tải lại khi mốc này đổi/đến
hạn. Thử ca một hold hết hạn mà không có DML, không đợi cron. Đây chỉ là hạn hiệu lực
của snapshot, không trả ID hay nội dung giữ chỗ. Thu hồi token hoặc đổi scope phải được
phản ánh tức thì ở RPC, không chỉ đợi revision. Đổi scope thay opaque scopeEpoch và xóa
cache cũ, bỏ response cũ tới muộn. Version chỉ theo scope token, không counter toàn org
rộng hơn quyền xem. Client clock lệch không kéo dài snapshot. Endpoint cần budget,
rate limit, no-store phù hợp; `public_room_events` là analytics ghi từ browser, không dùng
làm event bus đáng tin. Chưa đề xuất private-channel broker vì repo chưa có auth cho nó.

## 8. Nghiệm thu và blocker phát hành

Các test mới dưới đây là việc cần viết, chưa tồn tại/chưa chạy trong phiên này:

1. Ma trận projector: báo tương lai; đúng ngày; quá hạn vẫn ở; dời/hủy; đã trả+dọn; dọn
   trễ; ready; pass+hold; hold hết hạn; cọc đã settled; contract mới; turnover cũ hoàn tất.
   Cả public/in-app/copy/ảnh xuất dùng cùng nghĩa, không còn ngày cũ hay fallback end_date.
2. Hai giao dịch cạnh tranh notice/sweep, hold/trả phòng, ký mới/ready. Retry không sinh
   thêm work-item/job dọn sửa/notification; mất response vẫn read-back đúng revision.
3. Tắt toàn bộ browser qua các mốc nhắc: việc và notification vẫn sinh. Giả lỗi giữa
   claim/enqueue/finish, restart và scheduler trễ; overdue vẫn tồn sau READ/xóa thông báo.
4. JWT của quản lý, sale, người dọn, hết membership và cross-org; anon token revoked,
   token scope khác; payload/version không rò dữ liệu nội bộ. Kiểm REST trực tiếp không
   đóng nhắc việc hoặc sửa audit bằng quyền tasks chung.
5. Tiền/cọc/hold không đổi khi báo, nhắc, dọn; TRACKING không tạo thưởng, APPROVED_PAID_JOB
   giữ chính sách đã duyệt. Generic patch không đổi classification. Mutation tests
   bỏ guard org, revision, hold, deadline phải đỏ đúng nguyên nhân.

Lệnh nền đã có: `npm run typecheck:baseline`, `npm run build`,
`npm run gate:realtime-query-keys`, `npm run gate:realtime-key-ownership`,
`npm run gate:realtime-descriptors`, `npm run gate:realtime-surface`;
`npx vitest run src/lib/__tests__/publicRoomsHoldingDepositMigration.test.ts src/hooks/__tests__/realtimeTenantBoundary.test.ts src/hooks/__tests__/useRealtimeDataSync.test.ts src/pages/phong-trong/__tests__/roomListTable.test.ts`.
E2E mới chạy từ `.e2e-fleet/` bằng `npx playwright test specs/<spec-moi>.spec.ts`, headless
trên TEST/DEMO và dọn fixture. Đăng ký runner theo test-matrix; không tính skip là pass.

Schema/RPC cần catalog/ACL/owner/search_path/PostgREST, provenance/types, gate stable-fn-locks
và RLS thật; lịch triển khai cần `npm run check:external-controls`. Vì nối jobs/lương và
hold/tiền, kiểm reconcile v1/v2 cùng snapshot bất biến. Draft PR và review độc lập theo
Contract; không apply schema trong đợt lập plan này.

Blocker cần giải trước phát hành: chốt semantics rút tin quá hạn/pass+hold; kiểm catalog
token scope và policy jobs; chọn scheduler có runtime proof, đường drain đủ nhịp và
heartbeat cảnh báo; kiểm toàn bộ writer bump version; đóng work-item theo nguồn và guard
payroll của job dọn/sửa. Không có blocker cho việc viết plan. Chưa xác minh database sống,
publication, cron đang bật, delivery push, tải polling, hay E2E trong audit này.

Kiểm chứng tài liệu: `npm run docs:check:links` sau lần đồng bộ master đạt, 0 lỗi.
Không gọi test nghiệp vụ/database; kết quả link không chứng minh runtime.
