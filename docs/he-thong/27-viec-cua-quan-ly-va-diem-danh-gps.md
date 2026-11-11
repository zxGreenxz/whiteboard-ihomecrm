# Việc của quản lý và điểm danh GPS tự động

Chủ công ty và super admin xem «Hôm nay» của từng quản lý: đang làm gì, hành trình trong ngày trên bản đồ, lịch tháng, báo cáo so sánh theo kỳ. Máy Android của quản lý tự ghi vị trí theo các khung giờ chủ đặt. Chủ chốt tháng 11/2026. Plan: [2026-11-09-viec-cua-quan-ly-va-diem-danh-gps](../superpowers/plans/2026-11-09-viec-cua-quan-ly-va-diem-danh-gps.md).

Những điểm đã chốt:

1. Người xem: super admin và vai Chủ công ty. Quản lý không xem chéo nhau. Chỉ xem, không sửa dữ liệu của người được xem.
2. Danh sách người: quản lý có cấu hình lương đang hiệu lực hoặc có ngày công v5 trong 30 ngày.
3. Dấu GPS chỉ để giám sát: **không tính vào ngày công hay lương**. Ngày công v5 vẫn tick theo việc xong, check nhà FULL, thu tiền.
4. Báo cáo không tự chấm điểm, không quy ra tiền. Chủ tự ghi nhận xét và xếp loại A/B/C.
5. App nội bộ, mặc định coi như nhân viên đã đồng ý; không có màn đồng ý. Android vẫn buộc người cầm máy tự cấp quyền vị trí khi cài.

## Người dùng thấy gì

| Màn | Route | Ai vào | Nội dung |
|---|---|---|---|
| Cả đội | `/my-day/team` | Chủ công ty, super admin | Thẻ từng quản lý, toà quá hạn ghé, lối vào báo cáo và cài đặt |
| Một quản lý | `/my-day/nguoi/:userId` | như trên | Ngày công, phiên đang làm, dấu chân gần nhất, dải mốc điểm danh, toà còn phải ghé, việc đang mở |
| Hành trình | `/my-day/nguoi/:userId/hanh-trinh?ngay=` | như trên | Bản đồ các điểm dừng, dòng thời gian, tổng kết ngày |
| Lịch tháng | `/my-day/nguoi/:userId/lich?thang=` | như trên | Mỗi ô một ngày, từ tháng bắt đầu chấm v5 |
| Báo cáo | `/my-day/bao-cao` | như trên | 12 chỉ số đặt cạnh nhau, dải ngày công, toà quá hạn, nhận xét A/B/C, xuất Excel |
| Điểm danh | `/my-day/diem-danh` | Mọi người đăng nhập; máy chủ báo «không áp dụng» nếu không thuộc danh sách | Tình trạng máy, mốc hôm nay, tải app, ghép máy |
| Cài đặt điểm danh | `/my-day/diem-danh/cai-dat` | Chủ công ty, super admin | Bật/tắt, tần suất 15/30/60 phút, nhiều khung giờ, ngày nghỉ, áp dụng cho ai |

Ô «Hôm nay» giữ nguyên cho chính mình; chủ thấy thêm bộ chọn người ở đầu màn. Máy tính mở từ menu «Việc của quản lý» và từ Vận hành lương v5.

## Dữ liệu

| Đối tượng | Vai trò |
|---|---|
| `app_private.staff_day_can_view_v1(user)` | Cổng xem theo người: chính mình; vai Chủ công ty của đúng tổ chức lương của người đó (tổ chức mà dữ liệu được đọc ra); super admin là thành viên tổ chức đó |
| `app_private.staff_day_viewer_org_v1(org)` | Tổ chức đang xem cả đội; 42501 nếu không phải chủ/super admin thành viên |
| `public.staff_day_{team,summary,route,journey,calendar}_v1` | Hàm đọc của các màn; `STABLE`, không ghi, không trả tiền |
| `public.staff_period_report_v1(from, to)` | Báo cáo kỳ, tối đa 93 ngày |
| `app_private.staff_period_reviews` + `staff_period_review_set_v1` | Nhận xét và xếp loại tay |
| `app_private.gps_checkin_settings` | Cài đặt theo phiên bản, chỉ thêm; đổi cài đặt có hiệu lực từ mốc kế tiếp |
| `app_private.gps_checkin_members` | Bật/tắt theo người, chỉ thêm dòng: tắt một người không làm mất mốc của các ngày trước |
| `app_private.gps_checkin_{devices,pair_codes,pings}` | Máy đã ghép, mã ghép một lần, dấu vị trí (mỗi máy một dấu cho một mốc) |

Năm bảng `gps_checkin_*` bật RLS, không policy, thu hết quyền; chỉ vào qua hàm.

Dấu vị trí giữ 180 ngày (`retention_days` của `gps_checkin_settings_set_v1`; màn cài đặt chưa có ô này). Quá hạn thì không màn nào đọc được toạ độ nữa. Toạ độ bị xoá hẳn ở lần kế tiếp một máy của tổ chức báo về hoặc chủ lưu cài đặt, giữ dòng để còn đếm. Không có cron: nếu mọi máy đã gỡ và không ai lưu cài đặt thì dòng cũ nằm yên, chỉ không đọc được.

`get_my_day_summary()` không dùng lại được cho chủ vì nó có ghi (`v5_recompute_streak`) và trả tiền tạm tính. Vì vậy chuỗi ngày ở màn của chủ đọc `salary_streak_state` nguyên trạng.

## Thu tiền trên hành trình

Sự kiện thu tiền lấy từ `invoice_payment_collections.actor_id`. Toạ độ chỉ có khi phiếu thật sự có GPS; thu chuyển khoản không chứng minh người đó có mặt, nên thu tiền không có GPS không thành điểm dừng trên bản đồ.

**Hiện trạng cần biết (đo production 09/11/2026):** `income_expenses.collect_*` không có dòng mới từ 19/07/2026, tức GPS của phiếu thu không còn được ghi. Vì thế báo cáo chỉ đếm «lượt thu tiền» và nêu số có GPS khớp khi có.

## Phiên kiểm tra «có mặt»

`complete_inspection` không ghi `ended_at` cho phiên chưa đủ điều kiện, và job đêm đổi `presence` thành `expired` nhưng giữ `fail_reasons`. Các hàm đọc coi `expired` có `fail_reasons` là có mặt; chỉ phiên mở rồi bỏ mới là hết giờ. Giờ xong lấy theo ảnh cuối và thời gian ở toà. Phiên có mặt không còn hiện «đang làm» sau 15 phút không có thao tác.

## Cách tính mốc

Hợp đồng đầy đủ ở Phụ lục A và B của plan. Tóm tắt:

- Mốc mong đợi = từng khung giờ, cách đều theo tần suất, tính cả đầu khung, chỉ giữ mốc rơi vào khoảng hiệu lực của phiên bản cài đặt. Bỏ Chủ nhật, lễ, phép đã duyệt theo công tắc.
- Chỉ tính mốc mà đúng lúc đó người này đang được áp dụng và có máy đang ghép: mốc trước khi ghép, hoặc trong khoảng máy đã thu hồi mà chưa ghép máy mới, không vào mẫu số.
- Cổng nhận chỉ lưu dấu có `slotAt` đúng là một mốc mong đợi và `recordedAt` từ 2 phút trước mốc tới hết hạn trễ.

| Trạng thái | Điều kiện |
|---|---|
| Có dấu | Dấu `fresh`, hoặc dấu `stale` mà vị trí không quá 2 phút tuổi |
| Có dấu — đứng yên | Dấu `stale`, máy báo đang ngủ, vị trí quá 2 phút nhưng không quá 60 phút tuổi |
| Mất tín hiệu | Hết hạn trễ mà không có dấu hợp lệ, kèm lý do máy báo |
| Đã tắt | Quản lý bấm tạm dừng trong app |
| Chờ máy gửi | Mốc đã qua, còn trong hạn trễ cộng 5 phút |
| Chưa tới | Mốc ở tương lai |

Ngoài khung giờ máy không lấy vị trí, chỉ báo tình trạng máy; máy chủ cũng từ chối lưu dấu ngoài khung. Chỉ mốc có dấu mới trả toạ độ để vẽ bản đồ.

## App và cổng nhận

- App: từ bản 2.0.0 điểm danh là một phần của app **iHome Gateway** (`extensions/sms-webhook/android/`, `applicationId vn.ihome.smsgateway`; mã phần điểm danh ở gói Java `vn.ihome.diemdanh`). Mở app thấy màn hình đầu với hai thẻ «Điểm danh» và «Biến động số dư»; mỗi phần chỉ xin quyền ở màn của mình. App «iHome Điểm danh» riêng (`vn.ihome.diemdanh`, 1.0.x) không còn được build; máy đang dùng app cũ phải cài iHome Gateway, ghép lại rồi gỡ app cũ. CI: `.github/workflows/android-gateway.yml`. Bản phát hành do GitHub Release giữ, gắn thẻ `v<phiên bản>` (ví dụ `v2.0.0`); hằng số `GPS_CHECKIN_APK` ở `src/lib/gpsCheckin.ts` trỏ tới bản hiện hành. Play Protect chặn cài APK này từ trình duyệt hoặc trình quản lý tệp vì app khai báo `RECEIVE_SMS` và dịch vụ đọc thông báo; xem [hướng dẫn Android](../../extensions/sms-webhook/android/README.md).
- Cổng nhận: edge function `gps-checkin-ingest`, `verify_jwt = false`. Máy gửi bearer do app tự sinh; máy chủ chỉ giữ SHA-256. Ba sự kiện: `device.pair`, `location.ping`, `device.state`. Quá 120 dấu một phút trên một máy thì trả `429`.
- Số đo lúc lấy vị trí: từ app 1.0.1 mỗi `location.ping` kèm khoá tuỳ chọn `diag` (báo thức trễ bao lâu, lấy vị trí mất bao lâu, nguồn định vị nào trả lời; không có toạ độ), lưu ở `gps_checkin_pings.capture_diag`. Cổng nhận từ chối khoá lạ bằng `400` và máy coi dấu đó hỏng hẳn, nên thêm khoá mới thì máy chủ phải lên production trước bản app gửi nó.
- Ghép máy: quản lý tạo mã một lần ở `/my-day/diem-danh` (hạn 10 phút), mở app bằng link `ihomediemdanh://pair?c=<mã>` hoặc gõ mã. Mỗi người một máy; ghép máy mới thì máy cũ bị thu hồi.

## Bản đồ

Leaflet, nạp động trong `JourneyMap`. Ảnh nền thử lần lượt OpenStreetMap, OSM Đức, OSM Pháp; đổi nguồn thì sửa `img-src` trong `vercel.json` và `scripts/test-env/chrome.mjs`. Không tải được ảnh nền thì hiện danh sách điểm dừng kèm link Google Maps.

## Kiểm thử

| Lớp | Lệnh |
|---|---|
| SQL trên Postgres trong bộ nhớ | `npx vitest run scripts/__tests__/gps-checkin-sql.test.mjs` |
| Quyền trên schema thật, project TEST, ROLLBACK | `node scripts/test-staff-day-authz.mjs` (thêm `--dot-bien` để kiểm đột biến) |
| Cách ly giữa công ty | `scripts/test-cross-tenant.mjs`, các ca `staff_day.*`, `staff_period.*`, `gps_checkin.*` |
| Cổng nhận | `deno test --config supabase/functions/gps-checkin-ingest/deno.json supabase/functions/gps-checkin-ingest/index.test.ts --allow-env` |
| Công thức hiển thị | `src/lib/__tests__/{staffDay,staffReportMetrics,gpsCheckin}.test.ts` |
