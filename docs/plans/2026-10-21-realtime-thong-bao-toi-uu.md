# Tối ưu realtime + đồng bộ hai kênh thông báo + trang Cài đặt thông báo (21/10/2026)

Nguồn: workflow kiểm 13 agent ngày 21/10/2026 (6 mảng + phản biện + soát thiếu sót), đo production CHỈ ĐỌC.
Chủ đã chốt 4 điểm: (1) nhắc hoá đơn/HĐ/cọc chuyển lên server; (2) drain push chung **15 phút**; (3) push tin
nhắn Zalo **để sau**; (4) trang cài đặt **đầy đủ + giờ yên cá nhân**.

## 1. Hiện trạng (kết luận đã phản biện)

| Mảng | Đúng | Sai / cần tối ưu |
|---|---|---|
| Hub realtime | 4 gate + 63 test xanh; 17 bảng hub ⊂ publication 27 bảng; debounce/trần chờ, ref-count, token refresh đúng | Không bắt kịp sau rớt kênh/ngủ máy/tab nền (P1); CLOSED từ server ⇒ hub chết tới F5; màn phòng/sơ đồ toà/duyệt phiếu/chi tiết HĐ-hoá đơn/công tơ không tự cập nhật; một giao dịch nhiều bảng refetch 2–4 lần |
| Kênh khác | Dọn kênh đúng | Zalo/Network Center subscribe trần, không bắt kịp; NC nghe nhịp tim ~6.300 lần/ngày không ai đọc (~21 RPC/nhịp); Zalo mỗi tin kéo ~2 MB; Sidebar poll RPC 759 ms chỉ để hiện 1 mục menu |
| Thông báo server | RLS own-row, ranh giới công ty, trigger E1–E6 ghi org | 0 thiết bị push active từ 05/10; drain 1 lần/ngày 07:00 (trễ p50 15,9 h); claim không lọc dòng đã đọc, gộp chéo công ty, DUPLICATE→SENT giả, E1 kẹt sau 3 lượt; user tự sửa được cột push_*/created_at; digest v5 hỏng từ 17/09 (42501); v5_appeal/report_device_issue ném 23502 |
| Thông báo client | Lọc đúng người/công ty, chưa đọc = PENDING | Kênh notif chỉ nghe INSERT (đọc ở máy A, máy B vẫn đỏ); không bắt kịp; bấm push không đánh dấu đọc; đọc trong app không đóng thông báo hệ điều hành; đăng xuất không gỡ push; 75% thông báo do trình duyệt sinh ở Bảng tin, 91,5% nhắc hoá đơn chưa đọc đã lỗi thời |
| Cài đặt | Sở thích 7 họ × 2 kênh + cấu hình tổ chức có cổng server | Rải 3 nơi; 3 công tắc nhắc việc là giả; sở thích chỉ phủ ~26% thông báo; mobile thiếu gửi thử/hướng dẫn iPhone; không danh sách thiết bị, không chẩn đoán, không giờ yên cá nhân |

## 2. Thiết kế đích

```text
producer (trigger E1–E6, lane nhắc server, Hermes…) ──▶ cổng notify_gate / lifecycle_gate_v2
        │ in_app=true                              │ push=true
        ▼                                          ▼
 public.notifications (IN_APP, status)       push_state QUEUED / lifecycle delivery PENDING
        │ realtime INSERT/UPDATE/DELETE              │ pg_cron 15' → edge lifecycle-reminders
        ▼                                          ▼
 chuông/hộp thư mọi thiết bị  ◀── đã đọc ──▶  claim v2 (bỏ dòng đã đọc, kiểm lại cổng,
        ▲   (guard: READ ⇒ push SKIPPED)         giờ yên công ty + cá nhân, gộp theo user×org)
        └──── bấm push ⇒ SW ⇒ app đánh dấu đọc ◀── send-push (data: notificationIds, organizationId)
```

Bất biến:
- Một sự kiện = một dòng chuông (nếu in_app) + tối đa một push (nếu push), cùng tiêu đề/nội dung/url, cùng công ty.
- Push chỉ gửi dòng còn `status='PENDING'`; đã đọc ở bất kỳ đâu ⇒ không push nữa.
- Chưa đọc = `status='PENDING'` ở MỌI nơi (chuông, Hermes `notifications_inbox_v1`, Copilot feed); `CANCELLED` = việc đã xong, ẩn khỏi hộp thư.
- Event realtime chỉ là tín hiệu; dữ liệu luôn refetch qua RLS/RPC.

## 3. Gói việc và quyền sở hữu file

Bốn gói làm song song trong worktree riêng; file chung chỉ một gói sửa.

### Gói A — Realtime client + publication (chủ: A)

| Mã | Việc | File |
|---|---|---|
| A1 | Module dùng chung `subscribeResilient` + `channelHealth` (đã viết sẵn, A được chỉnh) | `src/lib/realtime/subscribeResilient.ts`, `channelHealth.ts` |
| A2 | Hub dùng A1; `catchUp` invalidate query active theo gốc key descriptor + business-performance + settlement/facts | `src/hooks/useRealtimeDataSync.ts`, `src/lib/realtime/catchUp.ts` |
| A3 | Phủ key: phòng/sơ đồ toà/chi tiết phòng-toà (RT-HUB-3, + `customer-contracts`), chi tiết HĐ-hoá đơn/chặn chốt sổ (RT-HUB-5), subtype báo cáo (RT-HUB-11), `pending-approvals`, công tơ | `src/hooks/realtime/*` |
| A4 | Gom invalidate xuyên bảng trong một cụm (RT-HUB-7) | `src/lib/realtime/*` |
| A5 | Hub chỉ prefetch domain người dùng có quyền xem (RT-HUB-13) | `src/lib/prefetchPages.ts`, `prefetchGate.ts` |
| A6 | Dải "Mất kết nối cập nhật tự động" khi gián đoạn ≥10 s + nút "Tải lại dữ liệu" | `src/components/layout/RealtimeSyncBanner.tsx` (C mount vào MainLayout) |
| A7 | Network Center: bỏ nghe `network_worker_building_status`; tab ẩn giữ cờ chờ, flush khi hiện; deps qua ref; bắt kịp | `src/lib/network-center/runtime.ts`, `src/hooks/network-center/useNetworkCenter.ts`, test NC |
| A8 | Zalo: gom 800 ms/trần 2,5 s, tab ẩn đặt cờ, key exact, bắt kịp; chốt hội thoại mặc định + reset khi đổi công ty | `src/hooks/useZaloChat.ts`, `src/pages/chat-zalo/ChatZaloPage.tsx` |
| A9 | Poll: Sidebar tắt poll BP organizations; cash-handovers + zalo accounts 60 s→5'; Quay số dừng poll khi quay xong, trang người xem không poll nền | `Sidebar.tsx`, `useBusinessPerformance.ts`, `useCashHandovers.ts`, `QuaySo*` |
| A10 | Migration publication: ADD `meter_readings`, `meters` (có policy SELECT cho người cần thấy; `approval_*` không có ⇒ poll 60 s + focus). **Không** DROP `network_worker_building_status` trong đợt này (review chéo 22/10, RT-CLIENT-1/SQL-LIFE-5): Realtime tạo subscription cả kênh trong một transaction — client NC cũ còn nghe bảng này sẽ mất HẾT realtime NC; DROP để migration riêng sau promote (§6). Không REVOKE SELECT anon trên hai bảng công tơ (SQL-LIFE-9, lý do ở đầu migration); sinh lại surface | `supabase/migrations/20261021170902_realtime_publication_toi_uu.sql`, `contracts/surfaces/realtime-surface.json`, manifest NC |
| A11 | Viết lại `docs/he-thong/realtime-sync.md` (5 họ kênh, bắt kịp, chỉ báo, giới hạn postgres_changes) | docs |

### Gói B — Pipeline thông báo server (chủ: B)

| Mã | Việc |
|---|---|
| B1 | Trigger guard `notifications` cho `current_user='authenticated'`: INSERT ép `push_state/push_leased_at/push_idem_key=NULL`, `push_attempts=0`, `created_at=now()`; INSERT 4 loại nhắc legacy (`PAYMENT_REMINDER`,`OVERDUE_INVOICE`,`CONTRACT_EXPIRING`,`DEPOSIT_SHORTFALL`) **bị bỏ qua** (BEFORE trả NULL) để bản production cũ thôi đẻ nhắc; UPDATE chỉ ghi khi `status` PENDING→READ hoặc CANCELLED→READ (bản cũ tự dọn dòng CANCELLED), mọi cột khác giữ OLD; mọi UPDATE khác trả NULL (0 dòng, không ghi, không WAL/realtime); khi →READ mà `push_state='QUEUED'` thì `SKIPPED`. Nghiệm thu: không trigger BEFORE INSERT nào đứng trước `a00_notifications_guard` theo tên |
| B2 | `ALTER TABLE public.notifications REPLICA IDENTITY FULL` (DELETE qua được filter user_id) |
| B3 | `notify_claim_push_batch_v2` (+ wrapper public): dòng `status<>'PENDING'` ⇒ `SKIPPED`; kiểm lại cổng enabled/push (không truyền amount của E1); gộp theo (user, org); giờ yên công ty theo `org_timezone_v1` **và** giờ yên cá nhân ⇒ hoãn; QUEUED `push_attempts>=3` ⇒ FAILED; khoá theo lượt + tra `push_send_log` lượt trước (SENT/PARTIAL ⇒ SENT, lỗi ⇒ khoá mới); trả thêm `organization_id uuid`, `data jsonb` = `{notificationIds (≤20), organizationId}`. `notify_settle_push_batch_v2` xét sổ `push_send_log` của khoá TRƯỚC mọi nhánh lỗi: sổ SENT/PARTIAL và sent>0 ⇒ SENT (kể cả edge báo timeout/DUPLICATE), sổ SENDING ⇒ giữ nguyên (bước a xử lý sau 15'); outcome `DEFERRED`/`CONFIG_ERROR` ⇒ HOLD (về QUEUED, không tiêu lượt). Bản v1 giữ chữ ký, thân uỷ quyền v2 |
| B4 | `notify_ie_pending_refresh_v1`: khi bump thì reset `push_attempts=0`, `push_leased_at=NULL` |
| B5 | Nhắc server = mở rộng lane lifecycle: họ nguồn `INVOICE_DUE` (hoá đơn APPROVED/PARTIAL_PAID chưa xoá, hạn trong ≤3 ngày tới), `INVOICE_OVERDUE` (quá hạn), `CONTRACT_EXPIRING` (HĐ ACTIVE, `end_date` trong ≤30 ngày, chưa có ngày kết thúc thực), `DEPOSIT_SHORTFALL` (HĐ ACTIVE, `deposit_remaining>=10000`, `deposit_debt_mode` NULL/DEBT). Người nhận: `buildings.view` + `invoices.view` (hai họ hoá đơn) / `contracts.view` (hai họ HĐ) trong phạm vi toà. Một dòng/người/ngày/họ; số cập nhật mỗi lượt; về 0 ⇒ dòng PENDING thành `CANCELLED` (áp cả NOTICE/TURNOVER/EXIT); người nhận tắt trong app (cá nhân/công ty/cadence OFF) ⇒ dòng PENDING của họ thành `CANCELLED` (`PREFERENCE_DISABLED`, không đụng READ), bật lại trong ngày ⇒ mở lại. `type` giữ enum cũ tương ứng; `metadata.event` = `BILLING` \| `CONTRACT_EXPIRY` \| `DEPOSIT` (LIFECYCLE giữ nguyên). `lifecycle_gate_v2(user, org, family)` đọc đúng khoá sở thích; claim/validate dùng v2. Chi phí (review chéo 22/10): edge gọi `lifecycle_reminder_org_ids_v1()` rồi `lifecycle_reminder_sweep_v1(<công ty>)` từng công ty (mỗi RPC một giao dịch 8 s, khoá công ty chỉ sống trong một công ty); tập toà được phép tính một lần cho mỗi (người, công ty, quyền) trong lượt; `sweep_state.had_payload` đếm người nhận; claim lọc thiết bị/lượt/giờ yên TRƯỚC LIMIT, so ngày + cổng trước payload, không gọi lồng validate (hình dạng trả về giữ nguyên). Đo TEST 22/10 (ROLLBACK, lượt đầu ngày): sweep 905 ms + 418 ms cho hai công ty (trước: 5,9–7,3 s một lệnh), lượt sau 18–20 ms; claim(10) mọi thành viên có thiết bị 234 ms (trước 4,5 s) |
| B6 | `app_private.notification_reconcile_stale_v1()` chạy mỗi lượt: E5 trỏ bàn giao đã rời PENDING ⇒ CANCELLED (`HANDOVER_RESOLVED`); E6a (nhắc chốt sổ — sinh ĐÚNG lúc bàn giao thành CONFIRMED) chỉ ⇒ CANCELLED (`CASHBOOK_CLOSED`) khi két đã chốt tới ngày xác nhận bàn giao (giờ công ty) hoặc sổ không còn/đã xoá/sổ ảo — đúng điều kiện im của producer `notify_closing_nudge_v1`; nhắc legacy (4 loại, `metadata->>'event' IS NULL`) còn PENDING ⇒ CANCELLED (đã có dòng gộp server thay thế). Ghi `metadata.cancelled_reason/cancelled_at` để khôi phục. Lần chạy đầu trong migration (đo prod 22/10: 2.696 legacy + 17 E5 + 0 E6a) |
| B7 | `public.notification_is_unread_v1(status)`; `notifications_inbox_v1` loại CANCELLED; `copilot_notification_feed_v1` chưa đọc = PENDING, loại CANCELLED |
| B8 | Khoá sở thích mới `BILLING`, `CONTRACT_EXPIRY`, `DEPOSIT` (CHECK + normalize + read); bảng `public.notification_quiet_hours` + RPC; `get/set_notification_org_config_v2`; `notify_gate_v1` chỉ áp `min_amount` cho E2* và E3 (đúng tập ô ngưỡng của UI — E6c dùng chung khoá E6 với E6a/E6b nên không áp) |
| B9 | `get_notification_delivery_health_v1` (+ `queue.oldest_eligible_queued_at`, `queue.deferred_quiet`; `last_drain_*` phạm vi hệ thống, `last_drain_error` chỉ super admin), `get_my_push_log_v1` |
| B10 | REVOKE anon trên `push_subscriptions`, `notification_logs`, `notification_templates`; REVOKE TRUNCATE authenticated trên `push_subscriptions`; dọn `push_send_log` >30 ngày mỗi ngày một lần; cột `push_subscriptions.revoked_at` (SETTINGS-1) |
| B11 | Digest v5: nhánh service/postgres cho `get_salary_v5_config` (org tường minh ⇒ bộ luật; org NULL ⇒ NULL như nhánh người dùng), `v5_route_candidates` suy org từ user, `v5_run_digest` cô lập lỗi theo từng nhân viên (WARNING); `v5_appeal` + `report_device_issue` ghi `organization_id` và người nhận = chủ công ty |
| B12 | Edge `lifecycle-reminders` chạy 3 pha/15': bảo trì (B6 + dọn log), lifecycle + nhắc (B5), drain chung v2 (lặp tới rỗng, tối đa 5 lô); mỗi pha cô lập lỗi và ghi vết. Module drain dùng chung `supabase/functions/_shared/push-drain.ts`; `salary-v5-jobs` bỏ drain ghép trong digest, job `push_drain` dùng module chung; lỗi ghi JSON. `send-push`: chuyển `data` (notificationIds ≤20, organizationId) vào payload; trùng khoá chỉ là DUPLICATE khi lượt trước SENT/PARTIAL/SENDING còn hạn |
| B13 | Helper `app_private.notify_push_allowed_now_v1(user, org)`; vá các lane gửi thẳng Hermes/canh gác hoãn ngoài giờ cho phép **chỉ khi** thay thế an toàn, không thì ghi known-gap |
| B14 | Cập nhật §4.5 `docs/he-thong/13-bao-cao-dashboard-thong-bao.md` |
| B15 | Ghim thân (review chéo 22/10, bài học PR #267/#261): mỗi migration 171249–171253 mở đầu bằng `$requires$` — mọi hàm đã có trên production mà file thay/vá phải có md5(prosrc, bỏ CR) bằng md5 thân production đo 22/10 hoặc md5 thân mới của chính file (lượt hai); lệch ⇒ dừng, nêu tên hàm. 171253 chuẩn hoá thêm URL dự án (bản đồng bộ TEST viết lại ref trong thân) |

### Gói C — Thông báo client (chủ: C)

| Mã | Việc | File |
|---|---|---|
| C1 | Kênh notif nghe `*` (filter user_id), gom 300 ms/trần 1 s; UPDATE chỉ invalidate khi status/subject/content đổi; bắt kịp qua A1 | `src/hooks/useNotifications.ts` (ngoài vùng parity) |
| C2 | `refetchOnWindowFocus` cho đếm + recent | như trên |
| C3 | `public/sw.js`: click ⇒ postMessage `notification-click` cho tab sẵn có (focus) hoặc `openWindow(url?notif=<ids>&org=<id>)`; url chuẩn hoá cùng origin; `pushsubscriptionchange` subscribe lại + báo app; `push-received` giữ | `public/sw.js` |
| C4 | Cầu nối SW↔app mount ở AppProviders: `push-received` ⇒ invalidate; `notification-click`/query `notif` ⇒ đánh dấu đã đọc, chuyển công ty nếu khác (`selectOrganization`), điều hướng SPA qua `resolveNotificationUrl` | `src/lib/push/serviceWorkerBridge.tsx`, `AppProviders.tsx` |
| C5 | Đọc trong app ⇒ đóng thông báo hệ điều hành (tag `crm-<id>`; chưa đọc = 0 ⇒ đóng hết); app badge = số chưa đọc (feature-detect) | `useNotifications.ts`, bridge |
| C6 | HomeLauncher hiện số/ẩn khi 0/ẩn khi thiếu quyền; MainLayout chỉ mount một chuông; mount `<RealtimeSyncBanner />` | `HomeLauncher.tsx`, `MainLayout.tsx`, `Header.tsx` |
| C7 | Đăng xuất gỡ đăng ký push (best-effort ≤3 s, trước signOut); khởi động đối chiếu đăng ký (thiếu dòng ⇒ lưu; dòng inactive ⇒ unsubscribe+subscribe+lưu) | `src/lib/push.ts`, `src/hooks/useAuth.ts`, `src/main.tsx` |
| C8 | `sendTestPush()` không ném với NO_DEVICE/ALL_FAILED/PARTIAL (422/502/207), trả `outcome` | `src/lib/push.ts` |
| C9 | Trang thông báo phân trang keyset 50 dòng, số chưa đọc từ hook đếm, tab chưa đọc lọc server; vùng parity loại CANCELLED (cập nhật `infra/hermes-broker/web-parity.json`) | `NotificationsPage.tsx`, `NotificationsMobilePage.tsx`, hook mới |
| C10 | Gỡ bộ nhắc trình duyệt (`useScheduledNotifications`, `notificationScheduler.ts`, phần dùng trong Dashboard); fallback `invoice_id/contract_id` qua `resolveNotificationUrl`; nút bánh răng ở chuông + trang thông báo dẫn `/account/notifications` | các file trên, `NotificationBell.tsx` |

### Gói D — Trang Cài đặt thông báo (chủ: D)

Route `/account/notifications` (ProtectedRoute, mọi thành viên), desktop + mobile, lazy.

| Mục | Nội dung |
|---|---|
| D2 Thiết bị này | Bật/tắt push, gửi thử (đọc `outcome`), chẩn đoán: hỗ trợ trình duyệt, quyền, service worker, đăng ký máy chủ khớp, 5 lần gửi gần nhất (`get_my_push_log_v1`); Safari iPhone chưa thêm MH chính ⇒ hướng dẫn 3 bước; quyền bị chặn ⇒ cách mở lại |
| D3 Thiết bị đã đăng ký | Danh sách `push_subscriptions` của tôi (trình duyệt/HĐH từ UA, ngày bật, trạng thái, "máy này"), gỡ từng máy |
| D4 Loại thông báo | Ma trận họ × (Trong app / Đẩy về máy): E1–E6, LIFECYCLE, BILLING, CONTRACT_EXPIRY, DEPOSIT; "Đẩy" khoá khi "Trong app" tắt; chỉ gửi khoá vừa đổi |
| D5 Giờ yên của tôi | Bật/tắt, từ–đến (giờ công ty); giải thích push được hoãn, chuông vẫn ghi |
| D6 Nhắc trên thiết bị | Liên kết cài đặt nhắc "Việc của tôi" (cục bộ) |
| D7 Cho người có quyền cài đặt | "Cấu hình công ty" (v2, tên công ty đang chọn, bật/tắt họ, ngưỡng chỉ E2/E3 — khớp `notify_gate_v1`, giờ yên công ty, báo đè sửa) + "Sức khoẻ giao thông báo" |
| D8 | Gỡ 3 công tắc giả + mặc định ở Cài đặt chung; tab Thông báo ở Cài đặt chung dẫn sang trang mới; Hồ sơ/Tài khoản mobile thay thẻ cũ bằng liên kết |

## 4. Hợp đồng giao tiếp giữa các gói

RPC mới (B cài, D/C gọi; tên và hình dạng cố định):

| RPC | Tham số | Trả về |
|---|---|---|
| `get_my_notification_quiet_hours_v1` | `p_organization_id uuid` | jsonb `{enabled, quiet_start, quiet_end, updated_at}` (chưa có dòng ⇒ `enabled=false, 21, 7, null`) |
| `set_my_notification_quiet_hours_v1` | `p_organization_id uuid, p_enabled boolean, p_quiet_start int, p_quiet_end int` | jsonb như trên (biên nhận) |
| `get_notification_org_config_v2` | `p_organization_id uuid` | jsonb `{organization_id, organization_name, events, quiet_start, quiet_end, updated_at, updated_by}` — cần `settings.view` |
| `set_notification_org_config_v2` | `p_organization_id uuid, p_events jsonb, p_quiet_start int, p_quiet_end int, p_expected_updated_at timestamptz` | jsonb như get; lệch `updated_at` ⇒ lỗi `PT409` — cần `settings.edit` |
| `get_notification_delivery_health_v1` | `p_organization_id uuid` | jsonb `{generated_at, members_total, members_with_device, active_devices, queue:{queued,sending,oldest_queued_at,oldest_eligible_queued_at,deferred_quiet}, last_7d:{sent,no_device,failed,skipped}, lifecycle:{push_states,last_success_at}, push_log_7d:{<outcome>:n}, no_recipient_7d:[{event,reason,n}], drain_scope:'system', last_drain_at, last_drain_ok_at, last_drain_error}` — cần `settings.view`. `oldest_eligible_queued_at` = dòng QUEUED cũ nhất NGOÀI giờ yên công ty/cá nhân (cảnh báo "drain hỏng" phải dựa vào trường này, không vào `oldest_queued_at`); `deferred_quiet` = số dòng QUEUED đang hoãn vì giờ yên. `last_drain_*` là phạm vi HỆ THỐNG (một lượt drain cho mọi công ty); `last_drain_error` chỉ trả cho super admin, người khác nhận `null` |
| `get_my_push_log_v1` | `p_limit int default 10` (1..50) | bảng `(created_at timestamptz, outcome text, sent int)` của chính mình |

RPC lane edge (service_role, review chéo 22/10 — agent edge code theo):

| RPC | Hợp đồng |
|---|---|
| `lifecycle_reminder_org_ids_v1()` | `uuid[]` công ty ACTIVE (sắp theo id). Edge gọi rồi lặp `lifecycle_reminder_sweep_v1(p_organization_id => <id>)` TỪNG công ty, mỗi lời gọi một RPC (giao dịch + ngân sách 8 s riêng); một công ty lỗi không chặn công ty khác và không chặn claim. `sweep_v1()` không tham số vẫn chạy (mọi công ty, một giao dịch) cho edge cũ |
| `lifecycle_reminder_claim_v1(p_limit)` | Hình dạng trả về KHÔNG đổi (mảng jsonb như `lifecycle_reminder_validate_v1`). Claim không còn gọi lồng validate — edge vẫn phải gọi `lifecycle_reminder_validate_v1(p_id, p_lease)` ngay trước khi gửi (như runner hiện tại) |
| `notify_settle_push_batch_v2(p_results)` | Phần tử `{idem_key, outcome, retryable, error, sent}`. Sổ `push_send_log` của khoá xét trước: SENT/PARTIAL và sent>0 ⇒ SENT; SENDING ⇒ giữ SENDING (không đếm vào kết quả). Outcome mới `DEFERRED` (edge CHƯA gửi lô — hết ngân sách thời gian) và `CONFIG_ERROR` ⇒ HOLD: về QUEUED, `push_attempts` lùi 1 (≥ 0), lease bỏ. `NO_DEVICE` ⇒ NO_DEVICE; `retryable=false` ⇒ FAILED; còn lại ⇒ thử lại/FAILED khi đủ 3 lượt |

Thiết bị (SETTINGS-1): cột `public.push_subscriptions.revoked_at timestamptz NULL`. Gỡ máy ở "Thiết bị đã đăng ký" = `UPDATE … SET is_active=false, revoked_at=now()` qua RLS `push_subscriptions_update_own` (không xoá dòng); `ensurePushSubscription` gặp dòng có `revoked_at` thì không tự lưu/đăng ký lại; chỉ công tắc bật chủ động đặt lại `revoked_at=NULL`; endpoint MỚI từ `pushsubscriptionchange` vẫn được lưu. `send-push` vẫn chọn theo `is_active`. Không đổi policy.

Sở thích hiện có: `get/set_my_notification_preferences_v1` giữ chữ ký; khoá mới `BILLING`, `CONTRACT_EXPIRY`, `DEPOSIT`.
Push payload (`send-push` → SW): `{title, body, url, tag, data:{notificationIds?: string[], organizationId?: string}}`.
`sendTestPush()` (C8): `Promise<SendTestPushResult & { outcome: string }>`.
`subscribeResilient` (A1): xem chú thích đầu file.

## 5. Kiểm chứng và phát hành

1. Mỗi gói: test hành vi (vitest; SQL theo khuôn test migration PGlite của repo; Deno nếu có khuôn), chạy gate liên quan.
2. Tích hợp: gộp nhánh, sinh lại provenance/surface/parity, `gate:truoc-push`.
3. Review chéo một lượt trên diff cuối (crossReview), sửa và re-review phần sửa.
4. `migrate:forward` dry-run trên production (ROLLBACK) → `--apply`; provenance/catalog/evidence; `gen:types`.
5. Deploy edge `send-push`, `lifecycle-reminders`, `salary-v5-jobs`; sinh lại manifest edge.
6. Playwright: `/account/notifications` (1280 + 375), chuông, console sạch. Đo sau apply: không còn QUEUED quá 15', thông báo lỗi thời đã CANCELLED, cron xanh.

Tương thích với bản production đang chạy (dùng chung database) — chỉ đúng một phần, nên **áp migration + deploy edge + promote client mới trong CÙNG một cửa sổ ngắn** (client mới cần RPC v2 nên migration đi trước; bước 4–5–promote liền nhau, kiểm sau apply rằng không còn bundle cũ phục vụ):
- guard B1 chặn nhắc legacy từ client cũ (insert không `.select()` ⇒ bỏ êm);
- badge chuông cũ đếm `status='PENDING'` ⇒ CANCELLED không vào số đếm, NHƯNG danh sách/tab "Chưa đọc"/tiêu đề trang của bản cũ coi mọi `status ≠ 'READ'` là chưa đọc ⇒ dòng CANCELLED hiện đậm. Bản cũ dọn được nhờ guard cho CANCELLED→READ (bấm dòng hoặc "đánh dấu tất cả"); UPDATE không hợp lệ ra 0 dòng (không ghi lại vô ích);
- publication: 170902 chỉ ADD `meters`/`meter_readings` (client cũ không nghe ⇒ an toàn, áp TRƯỚC promote); hub mới nghe hai bảng này nên KHÔNG promote/Preview trỏ production trước khi áp;
- UI mới chỉ ở Preview tới khi promote.

## 6. Ngoài phạm vi đợt này

Push tin nhắn Zalo (chủ: để sau) · chuyển postgres_changes sang Broadcast (lợi ~1,9% một core) · báo sự cố Network Center vào chuông · VAPID + E2E push trên TEST · patch payload Zalo thay refetch.

Follow-up sau phát hành (review chéo 22/10):
- Migration RIÊNG `ALTER PUBLICATION supabase_realtime DROP TABLE public.network_worker_building_status` — chỉ áp SAU khi promote client mới VÀ các tab cũ đã tải lại (client cũ nghe bảng này trong cùng kênh NC; thiếu một bảng ⇒ cả kênh mất realtime). Giữ thêm một vòng phát hành chỉ tốn ~6.300 lượt giải mã WAL/ngày. Ghi ở `tooling/known-gaps.yaml`.
- `meters`/`meter_readings`: anon vẫn có SELECT cấp bảng ⇒ event DELETE (chỉ mang khoá chính) tới cả subscriber anon. Chưa REVOKE vì anon còn EXECUTE hai hàm INVOKER đọc hai bảng và chưa chứng minh kênh nào không join dưới vai anon (REVOKE có thể làm hỏng cả kênh). Ghi ở `tooling/known-gaps.yaml`.
