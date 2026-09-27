# Review v2 — phòng sale, báo trả, nhắc việc và jobs

> Review source này có trước chốt cuối của chủ. Xem decisions.md và master: loại bắt buộc từ bước đầu, được chọn lại khi quyết toán có lịch sử; toàn bộ nghiệp vụ tiền giữ hiện hành. **Đính chính mới nhất:** bỏ cọc, xử lý/hủy hóa đơn nợ và credit giữ nguyên flow cũ; chủ đã rút mô tả giữ nợ. Đề xuất đổi policy/duyệt/chuyển tiền bên dưới là lịch sử phân tích đã được thay thế, không là việc được phép thực hiện. Chưa có runtime baseline mới.

Ngày 27/09/2026; source HEAD `e498f10d49f3548e72074095c955371d0cee41ab`.
Chỉ đọc source, [audit độc lập](../independent-audit.md),
[đề xuất sửa](../independent-verification/de-xuat-sua-plan.md), catalog và log đã lưu.
Không chạy script kết nối DB, không đọc vault, không sửa master/app/migration.
`LIVE/` dưới đây là `../independent-verification/live-catalog-prod-20260927/`;
thân hàm chụp lúc `2026-09-27T12:35:40.599Z`, không phải lần xác minh production mới.
`B:` là `supabase/baseline/schema.sql`; `M/` là `supabase/migrations/`.

Kết luận: tiếp nhận các lỗi thuộc phạm vi này; cần cụ thể hóa thiết kế trước thi hành.
Không nhận nguyên xi giải pháp `MAX(sequence)` cho revision và không coi pass là claim.
Các schema/API bên dưới là đề xuất để nhập vào master v2, chưa tồn tại trong app.

## 1. Phán định từng IA liên quan

| IA | Phán định | Bằng chứng và giới hạn | Sửa đưa vào master |
|---|---|---|---|
| IA-02/03 | ACCEPTED, phần notice/transfer | LIVE `transfer_room:130–154` và client `useContractOperations.ts:96–126` thay vòng đời ngoài notice. Guard chỉ ở P6 là muộn. | Guard/write-token và inventory writer trước P2; chuyển cả UI/Copilot/trigger đường B sang adapter. Không cho cron cấp token cư trú. |
| IA-05 | ACCEPTED, phạm vi khóa | LIVE `transfer_room:48–60` advisory room rồi contract khác giao thức khóa dòng; `renew_contract_impl:13–37` không khóa. Saved test `test-probe-lock-order.json` chứng minh một cặp deadlock, không chứng minh mọi cặp. | Notice/renew/transfer theo order tổng đã được agent tiền chốt; reader public không lấy org business lock. |
| IA-06 | QUALIFIED | LIVE `room_has_holding_deposit`, `recompute_room_reservation`, `set_reservation_hold_terms_v1`; audit §4 liệt kê hold thao tác, phiếu mồ côi, deadline, deposits và pass. | Facts phải đọc đủ nguồn legacy trước P9. `hold_until` là hạn cần xử lý, không tự nhả cọc. Pass là nguồn quảng cáo, **không** là giữ chỗ độc quyền. |
| IA-07 | ACCEPTED | LIVE `get_public_available_rooms:50–61,105–106` lấy contact và cho pass thắng hold; schema catalog không có contract/hạn/xác nhận. | Ràng buộc pass với lượt cư trú và phòng; đóng cùng transition, đồng thời facts tự loại pass stale. Không chỉ thêm nút tắt UI. |
| IA-08 | ACCEPTED, phạm vi cron | Catalog lưu cho thấy pg_cron tồn tại; source `scripts/test-env/khoi-phuc.mjs:24–29`, `hau-ky.mjs:110–116` có thể xóa job TEST. | Manifest lịch theo environment, kiểm lại sau sync; không tuyên bố cron chưa có hoặc tự giả định job lifecycle đã cài. |
| IA-13 | ACCEPTED, có đính chính | LIVE `renew_contract_impl:18–20` **có** kiểm status khi đọc; thiếu FOR UPDATE và predicate status ở UPDATE `:27–37`, nên vẫn race. | Khóa/recheck version/status/case/claim; xử lý notice bằng disposition tường minh trong cùng transaction. |
| IA-15 | QUALIFIED | UNIQUE có revision không bảo đảm một OPEN cho cả nguồn; schema chỉ năm phase không có queue hết hạn HĐ/tiền. Nhưng thêm tất cả kind vào một nguồn với một UNIQUE cũng có thể chặn hai nghĩa vụ độc lập. | Một OPEN theo **work stream**, không theo revision; notice là một stream. Digest một người/org/ngày; phạm vi queue tiền và lịch nhắc tách rõ. |
| IA-16 | QUALIFIED | `vercel.json:81–90`, Edge `salary-v5-jobs/index.ts:255–270` chỉ cấu hình drain hằng ngày; `notify_push_drain_rpc.sql:185–204` không recheck nguồn. Đây không phải bảo đảm delivery đúng 07:00. | Outbox riêng, revalidate recipient/source tại delivery, lease/retry/run-attempt. Không xóa notification để làm nguồn trạng thái; READ/xóa không resolve task. |
| IA-17 | ACCEPTED | LIVE `v5_tick_from_job:13–22`; LIVE `award_job_bonus` và `TaskCompleteDialog.tsx:121,130` đi qua attendance và popup ngoài legacy ledger. | Guard TRACKING ở mọi payroll entrypoint; kiểm SAD, `v5_month_money`, notification; giữ job trả công hiện hữu. |
| IA-18 | ACCEPTED | LIVE public RPC `:19–29,47,107` scope owner và trả `sale_bonus_note`; UI `PhongTrongPage.tsx:43,240–246`, `supabaseData.ts:124–125` lẫn SAMPLE/contact giả/lỗi mạng. | Scope token explicit, invalid/empty/error khác nhau, bỏ fallback giả, allowlist public, benchmark probe. |
| IA-19 | QUALIFIED; REJECTED giải pháp raw MAX(seq) | Không chạm `rooms/contracts.updated_at` là đúng; writer tiền guard tại `M/20260926160000…:3657–3718`. Bảng revision private hiện đề xuất cũng không bắt buộc chạm business rows. | Counter metadata theo building hoặc cursor có thứ tự commit được chứng minh. Sequence tự tăng đơn thuần không đủ; phản ví dụ ở §6. |
| IA-20 | ACCEPTED | LIVE `copilot_available_rooms_v1`; `worker/lib/vacant-rooms.js:143`; `M/20260830163815…:321–400`; `src/copilot/tools/registry.ts:1328`; `src/lib/roomStatus.ts:23–41`. | Một facts server cho public, nội bộ, Copilot, Zalo, copy/ảnh xuất; kênh chưa chuyển không được trả dữ liệu sale cũ. |
| IA-26 | ACCEPTED, tác động vận hành | LIVE `transfer_contract_impl:70–106` giữ contract ID, đổi đại diện. Chỉ bind pass/notice bằng contract ID chưa phân biệt hai lượt khách. | Identity lượt cư trú/occupancy revision; không carry pass/contact/notice sang khách mới. Chính sách tiền khi nhượng do review tài chính xử lý. |
| IA-30 | QUALIFIED | V2 không biết turnover nên guard READY chỉ ở activation mới không đủ. Nhưng guard bàn giao và undo là quyết định riêng, không phải lý do ẩn phòng đang dọn. | Mọi entrypoint nhận phòng dùng một readiness guard nếu chính sách được duyệt; sale vẫn free. Không thêm undo tự động trong slice A. |
| IA-33 | ACCEPTED, phạm vi quyền | B `:3292–3308` authorizer explicit actor lấy org FOR SHARE; B `:3632,4722` reader helpers dựa auth.uid. Hub hiện không phải subscription được scope tự động theo selected org. | UI reader dùng helper read-only; scheduler recipient dùng actor user UUID explicit dưới org prelock. Cleanup cache/subscription theo org. |
| IA-34 | QUALIFIED | `exit_case_id UNIQUE` không mô tả phòng rời do chuyển phòng/legacy. Huỷ hợp đồng chưa nhận không nhất thiết tạo nhu cầu dọn/sửa. | Turnover nguồn đa hình có validation; định nghĩa no-turnover. Không tự tạo công việc vệ sinh cho mọi SIGN_CANCEL. |
| IA-35 | ACCEPTED, phần evidence | `useNotifications.ts:174,206` ghi `status='READ'`, không có read_at. `M/20260731002000_notify_cashbook_closing.sql:48,71–108` đã thêm E6 cho preference/gate; log no-recipient cũ `M/20260729160000…:54` vẫn chỉ E1–E5. | Sửa tên trạng thái, kiểm từng validator khi thêm family lifecycle. Log baseline đã lưu có 20/496 khi loại outputs; không gọi đó là test mới. |

## 2. Pass và facts không được hồi sinh lịch/contact cũ

Pass bổ sung `contract_id`, `room_id`, `occupancy_revision`, `source`,
`confirmed_by_membership_id`, `confirmed_at`, `expires_on`, `version`, `closed_reason`.
`occupancy_revision` là generation của lượt khách/phòng, tăng khi nhận/rời/chuyển phòng/
đổi khách đại diện; không tăng chỉ vì sửa ghi chú. Nếu master chọn stay ID thì dùng ID ấy
thay generation, không tạo hai hệ nhận diện. Composite scope phải khớp org/toà/phòng/HĐ.
Backfill pass không đoán contract từ room hiện tại: đưa vào REVIEW_REQUIRED, xác nhận
người đăng và quyền công khai trước ACTIVE. Không xuất contact khi đang chờ xác nhận.

Facts chỉ dùng pass nếu active, chưa hết hạn theo org-local day, contract thực tế đang ở
đúng phòng/generation, nguồn xác nhận còn đúng, và không có next claim. Notice đổi/hủy/
quá hạn làm pass phụ thuộc ngày đó thành cần xác nhận; pass có ngày độc lập chỉ dùng sau
xác nhận riêng. Không thể dùng `avail_date` cũ để vượt D02. Trả phòng, chuyển phòng,
nhượng khách và activation/tạo HĐ mới tắt pass cũ trong transaction. Predicate facts là
lớp bảo vệ thứ hai nếu job cleanup trễ; không chỉ trông chờ UPDATE active=false.

Thứ tự: ngoài scope/khóa độc lập → claim → pass hợp lệ khi còn cư trú → notice hợp lệ
→ rented; khi không cư trú, turnover PENDING vẫn **free**, ngày nhận dự kiến hoặc
NEEDS_CONFIRMATION; READY là free/READY. Không cư trú, không turnover: phòng AVAILABLE
không có khóa độc lập vẫn free/NEEDS_CONFIRMATION; không tự chứng nhận READY. OCCUPIED
mà không có occupancy cần hàng đối chiếu, không tự quảng cáo từ dữ liệu mâu thuẫn.
Pass hết hiệu lực không thay đổi nghĩa free của phòng đã trả. Deadline cọc/claim của B
vẫn giữ nguyên khi xử lý pass/turnover của A.

Turnover dùng `source_kind EXIT_CASE|TRANSFER|LEGACY_END|SIGN_CANCEL`, `source_id`,
`room_id`, org/toà, version và partial unique room khi PENDING. Guard server xác minh
nguồn đúng phòng/org; polymorphic UUID không được coi như FK đã an toàn. SIGN_CANCEL
chỉ sinh turnover khi thực tế có nhu cầu bàn giao lại; không có cư trú thì không giả
ngày rời. Job cũ hoàn tất không mở lại turnover READY hoặc chiếm phòng của lượt sau.

## 3. Notice trong renew/transfer và race

Notice gắn **contract + room + occupancy generation**; cột expected cũ là projection.
Mọi writer dưới order tổng đọc lại trạng thái và version sau khóa, ghi event nguồn rõ
`entity_kind/entity_id`, disposition, người thao tác và lý do; audit lỗi rollback.

| Hành động | Disposition và tác dụng bắt buộc |
|---|---|
| Renew cùng khách/phòng | Khi OPEN, input bắt buộc `noticeDisposition=KEEP|CANCEL`; thiếu trả NOTICE_DISPOSITION_REQUIRED. KEEP xác nhận lại lịch, tăng revision; CANCEL có reason, xóa expected projection, resolve/supersede item/outbox. Không tự suy renew đồng nghĩa khách không đi. Chặn nếu case đã có/không ACTIVE-EXTENDED; claim B không bị nhả, lịch xung đột phải giải quyết rõ trước renew. |
| Transfer room thực tế | Kiểm target claim/readiness và cả hai scope, khóa phòng theo ID. Notice của phòng cũ được FULFILLED với resolution ROOM_TRANSFER, ngày chuyển thực tế và transfer ID; đóng reminder cũ. Tạo turnover TRANSFER ở phòng cũ, giữ next claim cũ. Notice phòng mới chỉ tạo bằng xác nhận riêng; không copy expected cũ theo contract.room_id. |
| Lịch transfer tương lai | Chỉ là kế hoạch; không cho API chuyển room_id thực tế trước khi bàn giao. Giữ notice/cư trú cũ cho tới transition thật. |
| Tenant transfer/nhượng | Adapter đã có policy identity mới thì đóng notice/pass của lượt cũ và tăng generation; lượt mới phải xác nhận riêng. Khi policy tiền/lượt chưa chốt, chặn writer nhượng cho contract đã enroll v2; không carry sang người mới. |
| Hủy báo / actual moveout | CANCELLED hoặc FULFILLED đóng đúng nguồn/revision/outbox nguyên tử. Không fallback end_date. Moveout không đợi quyết toán. |

Contract tới end_date mà không có notice chỉ tạo CONTRACT_END_CHECK nội bộ; không tự
rời phòng hay mở sale. Renew xử lý check đó cùng transaction. Race renew/transfer/
confirm phải có một kết quả serial hợp lệ hoặc VERSION_CONFLICT; không “gia hạn thành
công” trên hợp đồng đã TERMINATED. UI/Copilot/import/trigger đường B đều chịu guard.

## 4. Hàng việc, người nhận và quyền scheduler

`lifecycle_work_items` là nguồn tồn việc; jobs chỉ cho dọn/sửa. Đề xuất UNIQUE OPEN trên
`(organization_id, source_kind, source_id, work_stream)` **không chứa revision**.
NOTICE_CONFIRM có TOMORROW/DUE/OVERDUE là phase của một stream; phase/revision mới
supersede dòng cũ dưới khóa nguồn. Một exit case có thể có stream SETTLEMENT và REFUND
độc lập; không ép hai nghĩa vụ thành một bằng UNIQUE(source) quá rộng.

Slice A gồm NOTICE_CONFIRM, CONTRACT_END_CHECK, TURNOVER; HOLD_DUE đọc nguồn deadline
legacy mà không release claim. Khi slice B bật, hàng tiền SETTLEMENT_PENDING,
REFUND_PENDING, CUSTOMER_OWES phải đọc facts tài chính canonical, không lưu dư nợ riêng.
Không định nghĩa hạn tiền thì hiển thị “Chưa đặt hạn”, không tự gọi overdue. Chủ duyệt
lịch nhắc tiền trước bật; tồn queue không phụ thuộc opt-in notification.

Mỗi stream có `due_on DATE` hoặc `due_at TIMESTAMPTZ` đúng ý nghĩa, `source_revision`,
`responsible_membership_id`, state/resolution và snoozed_until. Notice quá hạn khi
org day > expected_on; job có deadline timestamp quá hạn theo instant. Không biến
DATE thành UTC midnight để tính nhầm ngày. Trước/đúng ngày nhắc lúc 08:00 org theo đề
xuất, sweep 15 phút; overdue badge dựa server clock dù chưa tới giờ gửi. Sửa/hủy/fulfill
invalidate outbox cùng transaction; sweep đối soát cả item mở có nguồn đã đóng/mất.
READ/xóa notification/snooze không giải quyết việc và không làm mất badge.
Ngày của sweep là `(as_of AT TIME ZONE org_timezone_v1(org_id))::date`; không dùng
org_today_v1(NULL) trong service. Index queue theo org/state/due và cursor ID; không
quét hoặc phân trang chỉ theo deadline không unique khiến bỏ sót các dòng cùng hạn.

Tách `lifecycle_delivery_outbox` từng item/revision khỏi `lifecycle_daily_digests` có
unique `(organization_id, recipient_user_id, local_day, digest_kind)`. Một digest chứa
các liên kết item đủ quyền tại thời điểm gửi; retry giữ ID. Năm việc không sinh năm
push. Notice tạo muộn vẫn vào queue ngay; nếu digest hôm nay đã gửi thì không tự gửi
lại chỉ vì nội dung/hash đổi. “Một lần/ngày” không dùng hash nội dung làm dedup key.
Đã supersede thì bỏ khỏi payload và đánh dấu SKIPPED cho pending push liên quan;
không xóa bằng chứng delivery. Push đã gửi không thể thu hồi: deep link luôn đọc trạng
thái hiện tại, không cho thao tác từ snapshot notification cũ.

**Không nhầm membership UUID với auth user UUID.** B `organization_memberships:113981`
có hai ID khác nhau; notifications.user_id và jobs.assignee_id đang là user UUID.
Resolver trả `{membershipId,userId,orgId,authorizationVersion,nearestDeadline}`;
validate membership ACTIVE, valid_from/to, role binding/deny và scope toà hiện hành.
Dedup người nhận theo user+org; membership dùng audit/quyền, không nhét vào user_id.
Jobs sinh nền phải có user_id chủ sở hữu hợp lệ theo mô hình jobs và organization_id
tường minh; assignee là user của membership đã kiểm. Không dùng auth.uid NULL làm owner.

Scheduler không dùng `can_access_building()` của người gọi hay giả JWT người nhận.
Private writer giữ org prelock ở statement trước rồi gọi
`authorize_tenant_action_v3(recipient_user, org, required_permission, building)`;
không gọi authorizer khóa này từ STABLE/public GET. Reader UI dùng can_v3/
authorized_scope_v3 theo auth.uid + org đã xác minh. Dispatcher kiểm lại source revision,
membership/scope ngay khi claim để gửi; recheck tại link/action. Việc revoke sau khi
gửi không thể thu hồi push nên nội dung lock-screen chỉ số việc và đường mở được bảo vệ.
Không có người nhận hợp lệ thì giữ queue “Chưa phân công”, ghi lỗi bền và báo owner
đủ scope, không broadcast org. E4 không tự chạy cho job nền: enqueue rõ ràng, tránh đôi
notification. Family mới phải cập nhật cả preference E1–E6 lẫn no-recipient validator.

Cron production là entrypoint private không tham số thời gian, lấy statement_timestamp;
inner sweep nhận as_of/org để test trên TEST/disposable. REVOKE mọi overload khỏi
PUBLIC/anon/authenticated; chỉ role scheduler đã xác minh EXECUTE. SECURITY DEFINER
không được dùng current_user=owner hoặc auth.uid IS NULL làm bằng chứng caller hợp lệ.
Không để service-only nghĩa là một RPC công khai nhận actor/org/as_of tùy ý. Scheduler
có quyền tạo work-item/outbox/jobs đúng source, không quyền tự confirm cư trú/quyết toán.

Saved catalog `catalog.results.cron_jobs` có 6 lịch active, không có lifecycle; TEST
có pg_cron nhưng sync có thể xóa job. Đăng ký `contract_lifecycle_sweep_v1` theo manifest
environment và kiểm sau sync. Run attempt có run_id/start/finish/heartbeat/cursor/error,
lease hết hạn cho retry; tách dedup business khỏi cron attempt. Nguồn lỗi không làm cả
ngày thành đã chạy. G-CRON cần runtime proof sau cài, catch-up không UI, failure alert.
Push hiện chỉ thấy lịch digest 00:00 UTC trong source, cap/quiet hours/transport có thể
làm trễ; v1 không cam kết push 15 phút. In-app queue phải chạy đủ dù push tắt/hỏng.

## 5. Jobs và payroll: guard theo nguồn, không chỉ checkbox

TRACKING không đi vào legacy ledger, `award_job_bonus`, `v5_tick_from_job` hoặc core
attendance khi source='JOB'. APPROVED_PAID_JOB tiếp tục policy hiện hành. Guard server
trên job đã link bảo vệ org/building/room/assignee/classification và không cho unlink
để thoát guard; thay hợp lệ qua RPC kiểm hai scope và version. Classification bất biến
sau completion/payroll effect; correction phải qua quy trình lương có audit, không
toggle exclude để sửa ngầm tháng đã chốt.

Test cả đường trực tiếp RPC và TaskCompleteDialog: SAD/tick evidence,
`v5_month_money`, legacy ledger, JOB/DAY_BONUS notification không tăng cho TRACKING.
Job được trả công hợp lệ không bị vô hiệu nhầm. Nếu tìm được tick cũ cần sửa, đối soát
theo job/source/ngày và mọi evidence khác trong cùng SAD trước điều chỉnh; không xóa
ngày công có nguồn FULL/PAYMENT hợp lệ. Chưa có bằng chứng tính năng mới đã sinh tick
production nên không backfill/xóa lương hàng loạt. Đóng việc bị hủy lưu resolution của
link/stream, không dựng completion lao động giả để né trạng thái chỉ có hai giá trị.

## 6. Revision, public scope và hiệu năng

IA-19 đúng về tránh thay business timestamps, nhưng raw `MAX(seq)` có counterexample:
T1 cấp seq=100 chưa commit; T2 cấp 101 và commit; probe thấy 101; T1 commit sau đó,
MAX vẫn 101. Client không refetch thay đổi của T1. Sequence không là commit order.
Append-only log vẫn hữu ích cho audit, nhưng không lấy MAX làm freshness cursor trừ
khi có cơ chế serialize allocation/commit hoặc watermark được test chứng minh.

Đề xuất v1: metadata revision row theo building + row metadata công khai cấp org
(settings/area mapping), độc lập rooms/contracts. Writer khóa theo order tổng rồi
increment các metadata rows bị ảnh hưởng theo ID cố định; mọi nguồn tham gia giao
thức, không lấy thêm business lock sau nhóm revision. Tách khỏi hot-row theo từng token
để không phải cập nhật N token khi đổi một phòng. Probe đọc vector counter của đúng
tập building và org-public-settings trong **một snapshot**, trả opaque digest dạng
string làm `revision`; thay contract bigint-string cũ bằng opaque version rõ ràng.
Counter tăng dưới row lock nên mỗi commit muộn vẫn thay vector; không dùng MAX các
counter. Có thể giữ decimal-string bằng tổng counter không giảm nếu master muốn,
nhưng không reset/prune counter trong epoch hiện hành. G-LOCK/test phải đo contention.

Token có org+tập building tường minh, scopeEpoch opaque, revoked/expiry và quyền quản
trị token; creator là lịch sử, không phải owner mặc định dùng để query phòng. Tạo token
nhân viên không được mở rộng quá quyền share scope được cấp. Legacy owner tokens map
đúng tập public hiện hữu sau review; không tự mở rộng. Token mới đủ entropy, hash lưu
server, không token trong logs. Scope/expiry/revoke được kiểm mỗi RPC; epoch đổi khi
scope đổi, purge cache trước tải mới. Không cấp anon SELECT revision/log/notice/jobs.

API public trả `VALID|INVALID`, payload rỗng VALID khác timeout. Full payload mang
`scopeEpoch, revision, orgToday, serverNow, nextTransitionAt` của cùng snapshot với facts.
Probe trả metadata tương ứng, không ID nguồn/private event. `nextTransitionAt`
TIMESTAMPTZ gồm hold không tiền được phép tự hết, pass expiry và các deadline đổi facts;
server day xử lý DATE. Phải refetch khi mốc tới/qua, kể cả cron không chạy và không DML.
Paid/pending-review claim không tự hết theo technical hold deadline.

Public allowlist bỏ `sale_bonus_note`, không fallback tenant/contact MANAGER giả.
Contact pass chỉ xuất khi pass hiện hành hợp lệ và cấu hình chấp thuận cho phép.
Rented tile nếu giữ trong floorplan chỉ có label/layout/status tối thiểu, không mang
ngày nhận/contact/pass của A. Copy, ảnh xuất, Copilot và Zalo dùng cùng facts và policy.
Kênh chưa chuyển phải tạm ngừng trả listing, không tiếp tục logic end_date cũ.

Nguồn bump phải bao gồm rooms/buildings, contract occupancy/notice, pass, turnover,
reservation/claim/hold, phiếu cọc mồ côi/approval/reversal/linking, reservation settlement,
reservation_hold_deadlines, legacy deposits, listing services/prices/images/hotline,
settings/areas và token scope. Chỉ bump khi projection public có thể đổi, không theo
mỗi thay đổi công nợ riêng tư. Hai wrapper công khai/nội bộ khác scope nhưng cùng facts.

Visible probe 5s có jitter, dedup inflight; focus/reconnect kiểm token rồi reload,
hidden dừng. Lỗi mạng có stale marker, last-success riêng token; revoked purge, response
cũ khác epoch/request sequence bị bỏ. Nội bộ hub phải key org/actor/scope, invalidation
mọi reader, cleanup org switch; vẫn có clock-boundary/focus fallback. Không gọi đây là
push realtime. Budget thử: 100 tab visible ≈20 probe/s; EXPLAIN trên >1000 rooms,
đo p95 probe/payload/lock-wait/DB load và p95 đổi→hiện ≤10s. Probe chỉ đọc token/indexed
metadata/time-boundary, không tính lại toàn JSON mỗi 5s. Timeout/rate limit/backoff có
metric; không coi p95 mục tiêu là số đo đã đạt.

## 7. Bằng chứng cần bổ sung và hai quyết định nghiệp vụ

Test cần viết/chạy trên TEST sau parity, chưa chạy trong review này:

1. Renew ∥ confirm; transfer ∥ notice revise; old room có next claim; đổi tenant cùng
   contract ID; pass A không có contact sau B; tất cả writer/trigger/Copilot cùng guard.
2. Rev1→rev2 ∥ sweep chỉ một OPEN stream; nhiều phase/nhiều việc thành một digest;
   READ/delete/snooze không mất overdue; không người nhận; revoke/đổi scope trước drain.
3. Cron fail giữa claim/enqueue, expired lease, sync TEST xóa job, không browser qua
   timezone midnight; `due_on` và deadline timestamp không bị lẫn; backlog >1000.
4. Recipient membership ID khác user ID; jobs sinh nền có owner hợp lệ; role mất scope,
   org B, actor-only read helper và cron EXECUTE bị từ chối ở role không được cấp.
5. TRACKING completion/direct RPC không tick/popup/phụ cấp; paid job giữ policy;
   immutable source link; correction không xóa evidence payroll khác.
6. T1/T2 commit đảo thứ tự vẫn đổi public version; multiple-building writer không
   deadlock; hold hết hạn không DML/cron; token epoch/cache response race; mọi kênh cùng
   facts; public REST không PII/note thưởng/fallback giả; benchmark tải có số đo.

Chỉ hai câu cần chủ quyết, không hỏi chọn DB/cron/counter:

- Tin nhờ sang phòng sẽ tự tắt khi khách rời/chuyển/nhượng; liên hệ mặc định hotline,
  chỉ công khai liên hệ người đăng khi đã đồng ý — có áp dụng quy tắc này không?
- Có dùng nhắc tổng trong app lúc 08:00 cho quản lý về phòng và cho người phụ trách
  tài chính về quyết toán/hoàn/nợ, mỗi ngày một lần khi quá hạn; push theo lịch hiện
  có và không bảo đảm tức thời — hay cần thay giờ/người nhận/phạm vi nhắc tiền?

Không hỏi lại việc dọn/sửa vẫn sale hoặc nháp không giữ phòng. Các quyết định bàn giao,
công tơ, cọc và nhượng tiền do master hợp nhất với review các domain khác.

Log đã lưu `baseline-vitest-rerun-excl-outputs.txt` ghi 20 file/496 test PASS; đó là kết
quả audit độc lập, không phải chạy lại hay test lifecycle mới. Chưa kiểm JWT/PostgREST,
cron mới, workload revision, browser/Zalo runtime hoặc push. Link check lượt này trả
exit 1: 350 Markdown/29 lỗi; 28 lỗi legacy và một duplicate `revision-v2/plan-v1-reviewed.md`
với master còn nguyên tại lúc kiểm. Không có lỗi ở file review này. Không sửa tài liệu
ngoài phạm vi để làm xanh tổng; master được sửa sau sẽ thay đổi phép đo duplicate.
