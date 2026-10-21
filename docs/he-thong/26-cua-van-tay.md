# Cửa vân tay (SmartLife/Tuya)

Trang `/cua-van-tay` nối CRM với máy vân tay ở cửa các tòa (thiết bị SmartLife, nền Tuya Cloud). Chủ chốt 21/10/2026, tám điểm:

1. Bốn quyền mới theo tòa: **Xem**, **Mật khẩu tạm**, **Mở cửa từ xa**, **Quản lý máy & vân tay**. Chỉ vai chủ công ty có sẵn (vai TENANT_OWNER, hoặc vai tự tạo tên "Chủ sở hữu tổ chức"/"Chủ công ty" — cùng định nghĩa `ie_actor_is_company_owner_v1`); vai khác chủ tự bật ở Phân quyền. Mọi thao tác ghi lưu nhật ký (ai, lúc nào, cửa nào, kết quả).
2. CRM liệt kê máy trong tài khoản SmartLife, gợi ý tòa theo tên; người có quyền Quản lý xác nhận. Mặc định chỉ hiện máy cửa (bỏ cảm biến, báo khói); máy không nhận ra loại hiện sau công tắc "Hiện cả thiết bị khác" và phải chọn loại khi gắn. **Gắn máy MỚI và tìm máy cần quyền Quản lý ở MỌI tòa** (sau review chéo 21/10: người quản lý một tòa không được tự gắn máy của tòa khác — chưa có trong CRM — vào tòa mình rồi mở cửa tòa đó); sửa máy đã gắn chỉ cần quyền ở tòa của máy (và tòa cũ nếu đổi tòa).
3. Màn **Đối chiếu**: số vân tay/thẻ/mật khẩu trên máy ↔ khách đang thuê tòa. Gắn vân tay thì số được điền vào ô "Mã vân tay cửa ra vào" của khách. Thêm vân tay mới vẫn làm tại máy hoặc app SmartLife.
4. Mục **Cần xóa**: vân tay gắn với khách không còn hợp đồng hiệu lực ở tòa. Người quản lý tự bấm xóa (xác nhận); CRM không tự xóa.
5. Mật khẩu tạm: CRM tự sinh số; mặc định 2 giờ (chọn nhanh 1 giờ, 2 giờ, hết hôm nay, tự đặt); **hết hạn chậm nhất 7 ngày kể từ lúc tạo**; dùng nhiều lần trong hạn; mã chỉ hiện một lần, CRM không lưu mã.
6. Lịch sử ra vào đọc trực tiếp từ SmartLife khi mở trang; CRM chưa lưu bản sao, Hermes chưa dùng.
7. Một tài khoản SmartLife cho một công ty (biến `DOOR_ACCESS_ORG_ID`).
8. Chưa có khóa Tuya thì trang báo "chưa kết nối"; có khóa thì chạy chỉ đọc trước (`DOOR_ACCESS_MODE=read`), kiểm trên máy thật rồi mới mở ghi (`all`).

## Người dùng thấy gì

| Phần | Quyền | Nội dung |
|---|---|---|
| Vào trang, chọn máy | Xem (vào trang); máy hiện ở tòa có quyền cửa bất kỳ | Máy đang hoạt động ở các tòa được phép. Người chỉ có "Mật khẩu tạm" mà không có "Xem" chưa vào được trang (registry capability chỉ nhận một quyền) |
| Lịch sử ra vào | Xem | Giờ, cách mở (vân tay số mấy, thẻ, mật khẩu, mật khẩu tạm, app), người (tên khách nếu số đã gắn; mật khẩu tạm tạo từ CRM ⇒ tên đặt lúc tạo; không thì tên trên máy) |
| Mật khẩu tạm | Mật khẩu tạm | Danh sách còn hiệu lực, người tạo (nếu tạo từ CRM), tạo mới, xóa |
| Đối chiếu vân tay | Xem; gắn/bỏ gắn/xóa cần Quản lý | Số trên máy ↔ khách; mục Cần xóa |
| Thiết bị | Quản lý (tìm máy + gắn máy mới: Quản lý ở mọi tòa) | Tìm máy trên SmartLife, gắn tòa, tắt máy khỏi CRM |
| Nhật ký thao tác | Xem | Thao tác ghi từ CRM và kết quả |
| Nút Mở cửa | Mở cửa từ xa | Hỏi xác nhận; lỗi mạng thì báo "chưa rõ cửa đã mở chưa", không tự bấm lại |

## Dữ liệu

- `door_devices`: máy đã gắn tòa. `tuya_device_id` duy nhất toàn hệ thống (một máy chỉ thuộc một công ty). `device_kind`: `access_control` (máy kiểm soát ra vào, category `mk`) hoặc `wifi_lock`. `channel_id` (kênh mở cửa, mặc định 1), `password_length` (độ dài mật khẩu tạm, 6–10, mặc định 7). Tắt máy = `is_active=false`, giữ lịch sử — đây là gỡ máy khỏi CRM, không phải khoá của chủ: người có quyền Quản lý ở tòa của máy bật lại được.
- `door_key_links`: số trên máy (`unlock_type` fingerprint|card|password + `unlock_sn`) ↔ khách (`customer_id`) hoặc nhãn (`label`, ví dụ nhân viên). Chỉ gắn được khách từng/đang có hợp đồng (không nháp) ở tòa của máy. Một số chỉ có một liên kết mở. Bỏ gắn ghi `unlinked_at` + lý do (MANUAL, RELINKED, DELETED_ON_DEVICE). Lịch sử ra vào chỉ gán tên khách cho lượt mở SAU lúc gắn (`linked_at`) — số được gắn lại không kéo lượt cũ sang người mới.
- `customers.fingerprint_code`: khi liên kết vân tay của một khách đổi, CRM ghi lại cột này = các số vân tay đang gắn (tăng dần, cách nhau ", "); hết liên kết thì về NULL — ghi đè giá trị gõ tay của chính khách đó. Liên kết là nguồn; cột là bản hiển thị/in hợp đồng. Hai thao tác cùng lúc trên một khách chạy lần lượt (khoá dòng khách).
- `door_action_logs`: nhật ký thao tác (REMOTE_UNLOCK, TEMP_PASSWORD_CREATE, TEMP_PASSWORD_DELETE, KEY_DELETE, DEVICE_SAVE, DEVICE_DISABLE, KEY_LINK, KEY_UNLINK). Thao tác gửi xuống máy ghi `PENDING` trước khi gọi Tuya rồi chốt `OK`, `FAILED` hoặc `UNKNOWN` (lỗi mạng/hết giờ — có thể đã chạy). Không lưu mật khẩu.
- Tình trạng thuê của một liên kết (theo tòa của máy): `CURRENT` (có hợp đồng chưa trả phòng, không nháp/thanh lý/chuyển nhượng ở tòa — gồm cả EXPIRED chưa trả phòng, để gợi ý xoá thận trọng), `MOVED_OUT` (từng có hợp đồng ở tòa, nay hết) ⇒ Cần xóa, `NO_CONTRACT` (không còn hợp đồng nào ở tòa, ví dụ hợp đồng bị xoá) ⇒ kiểm lại, `STAFF` (liên kết nhãn).

Bảng bật RLS, không cấp quyền bảng cho trình duyệt; đọc/ghi qua RPC dưới đây. Quyền kiểm bằng `authorize_tenant_action_v3` (ghi, sau `lock_org_for_decision_v1`) hoặc `can_v3` (đọc, không khoá dòng), luôn theo tòa của máy, và cần thêm quyền xem tòa (`can_access_building` = `buildings.view`).

## RPC (schema public, trả jsonb)

Mã lỗi Postgres: `42501` không có quyền/không thấy trong công ty, `22023` dữ liệu sai, `23505` trùng (máy đã thuộc công ty khác), `54000` quá nhiều thao tác, `55000` trạng thái đổi (máy đã tắt).

Gọi từ trình duyệt (authenticated):

| Hàm | Quyền | Trả |
|---|---|---|
| `door_access_devices_v1(p_organization_id uuid, p_include_inactive boolean default false)` | quyền cửa bất kỳ ở tòa; máy tắt chỉ hiện với Quản lý | `{devices:[Device]}` |
| `door_access_key_links_v1(p_organization_id uuid, p_device_id uuid)` | Xem | `{links:[Link]}` |
| `door_access_building_tenants_v1(p_organization_id uuid, p_device_id uuid)` | Quản lý | `{tenants:[{customer_id, full_name, room_id, room_name, contract_id, is_representative}]}` |
| `door_access_action_logs_v1(p_organization_id uuid, p_device_id uuid default null, p_actions text[] default null, p_limit int default 100, p_before timestamptz default null, p_before_id uuid default null)` | Xem (lọc theo tòa) | `{logs:[Log], has_more}`; trang sau: `p_before`/`p_before_id` = `created_at`/`id` của dòng cuối trang trước |
| `door_access_save_device_v1(p_organization_id uuid, p_tuya_device_id text, p_building_id uuid, p_display_name text, p_device_kind text, p_tuya_category text default null, p_tuya_product_name text default null, p_channel_id int default 1, p_password_length int default 7)` | Máy mới với công ty: Quản lý ở mọi tòa. Máy đã có: Quản lý ở tòa mới (và tòa cũ nếu đổi tòa) | `Device` |
| `door_access_disable_device_v1(p_organization_id uuid, p_device_id uuid)` | Quản lý | `Device` |
| `door_access_link_key_v1(p_organization_id uuid, p_device_id uuid, p_unlock_type text, p_unlock_sn int, p_tuya_user_id text default null, p_device_user_name text default null, p_customer_id uuid default null, p_label text default null)` | Quản lý; khách phải từng/đang có hợp đồng ở tòa của máy | `Link` |
| `door_access_unlink_key_v1(p_organization_id uuid, p_link_id uuid)` | Quản lý | `{id, unlinked:true}` |

Gọi từ hàm Edge `door-access`:

| Hàm | Ai gọi | Ghi chú |
|---|---|---|
| `door_access_authorize_v1(p_organization_id uuid, p_device_id uuid, p_permission text)` | JWT người dùng | Máy đang hoạt động + quyền ở tòa ⇒ `Ctx`; đọc trước khi gọi Tuya; STABLE, không khoá dòng tổ chức |
| `door_access_can_manage_org_v1(p_organization_id uuid)` | JWT người dùng | Quản lý máy ở MỌI tòa của công ty (tìm máy trên SmartLife) |
| `door_access_begin_action_v1(p_organization_id uuid, p_device_id uuid, p_action text, p_detail jsonb default '{}')` | JWT người dùng | Kiểm quyền theo thao tác, trần tần suất, ghi PENDING ⇒ `Ctx` + `log_id` |
| `door_access_finish_action_v1(p_log_id uuid, p_status text, p_tuya_password_id bigint default null, p_error_code text default null, p_error_message text default null)` | service_role | Chốt PENDING một lần; KEY_DELETE thành công tự bỏ gắn liên kết (DELETED_ON_DEVICE) |

Thao tác ⇒ quyền: REMOTE_UNLOCK ⇒ `door_access.remote_unlock`; TEMP_PASSWORD_CREATE/DELETE ⇒ `door_access.temp_password`; KEY_DELETE ⇒ `door_access.manage_devices`. Trần mỗi người: mở cửa 10 lần/10 phút, tạo mật khẩu tạm 20 lần/giờ, xóa 30 lần/giờ.

`p_detail`: TEMP_PASSWORD_CREATE `{name (1–20 ký tự), purpose (XEM_PHONG|THO|KHACH|KHAC), effective_sec, invalid_sec}` (kết thúc sau hiện tại và chậm nhất 7 ngày kể từ bây giờ, bắt đầu không sớm hơn 5 phút trước); TEMP_PASSWORD_DELETE `{password_id}`; KEY_DELETE `{unlock_type, unlock_sn, tuya_user_id, user_type (1|2)}`; REMOTE_UNLOCK `{}`.

Kiểu:

- `Device`: `{id, building_id, building_name, display_name, device_kind, tuya_device_id, tuya_category, tuya_product_name, channel_id, password_length, is_active, updated_at, can:{view, temp_password, remote_unlock, manage_devices}}`
- `Link`: `{id, device_id, unlock_type, unlock_sn, tuya_user_id, device_user_name, customer_id, customer_name, label, linked_at, linked_by_name, tenancy (CURRENT|MOVED_OUT|NO_CONTRACT|STAFF), room_name, contract_end_date}`
- `Log`: `{id, device_id, device_name, building_id, building_name, actor_id, actor_name, action, status, detail, tuya_password_id, error_code, error_message, created_at, finished_at}`
- `Ctx`: `{device_id, tuya_device_id, device_kind, channel_id, password_length, building_id, display_name}` (+ `log_id` ở begin)

## Hàm Edge `door-access`

`POST /functions/v1/door-access`, header `Authorization: Bearer <JWT>`, `x-organization-id`, thân `{action, ...}`. Trả `{ok:true, data}` hoặc `{ok:false, error:{code, message, tuyaCode?, outcomeUnknown?}}`.

| action | Tham số | Quyền | data |
|---|---|---|---|
| `status` | — | đăng nhập | `{configured, connectedOrg, mode}` |
| `discover` | — | Quản lý ở mọi tòa | `{devices:[{tuyaDeviceId, name, category, productName, online, kind (null = không nhận ra loại), registered:{deviceId, buildingId}\|null}], hasMore}` — trả MỌI thiết bị của tài khoản; giao diện tự ẩn loại lạ |
| `records` | `deviceId, startMs, endMs, pageNo?, pageSize?` (≤ 31 ngày, ≤ 50/trang) | Xem | `{records:[{id, at, kind, method, methodCode, slot, userId, userName, unlockName}], total, hasMore}` |
| `keys` | `deviceId` | Xem | `{users:[{userId, name, role, userType, methods:[{method, methodCode, sn, name}]}], unassigned:[{method, methodCode, sn}], partial}` |
| `temp_passwords` | `deviceId` | Mật khẩu tạm | `{passwords:[{id, name, phase, effectiveSec, invalidSec, deliveryStatus}], hasMore}` |
| `create_temp_password` | `deviceId, name, purpose, effectiveSec, invalidSec` | Mật khẩu tạm | `{passwordId, password, effectiveSec, invalidSec, logId}` |
| `delete_temp_password` | `deviceId, passwordId` | Mật khẩu tạm | `{deleted, logId}` |
| `remote_unlock` | `deviceId` | Mở cửa từ xa | `{unlocked, logId}` |
| `delete_key` | `deviceId, unlockType, unlockNo, tuyaUserId, userType?` | Quản lý | `{deleted, logId}` |

`deviceId` là id `door_devices` của CRM, không phải id Tuya. Mã lỗi: `unauthorized` 401, `organization_required` 400, `invalid_request` 400, `not_configured` 503 (thiếu khóa Tuya), `org_not_connected` 403, `mode_off` 403, `writes_disabled` 403 (chế độ chỉ đọc), `not_permitted` 403 (gồm cả máy không thấy trong công ty — SQL gộp hai trường hợp vào 42501, nên `device_not_found` không được trả), `conflict` 409, `rate_limited` 429, `tuya_rejected` 502 (Tuya từ chối, kèm `tuyaCode`), `tuya_unavailable` 504 (mạng/hết giờ/HTTP lỗi), `internal` 500.

Kết quả lệnh ghi: Tuya từ chối ⇒ FAILED; riêng mã hệ thống 500/501 của Tuya và lỗi mạng/hết giờ khi ĐÃ gửi lệnh ⇒ UNKNOWN + `outcomeUnknown:true` (lệnh có thể đã chạy, không tự gửi lại); lỗi ở bước xin/giải vé (trước khi gửi lệnh) ⇒ FAILED, không `outcomeUnknown`. Chốt nhật ký hỏng ⇒ câu trả lời kèm `logPending:true`.

Biến môi trường: `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `TUYA_BASE_URL` (máy chủ OpenAPI Tuya trong danh sách cho phép), `DOOR_ACCESS_ORG_ID`, `DOOR_ACCESS_MODE` (`off` | `read` mặc định | `all`). Không nạp khóa Tuya lên TEST.

## Giới hạn đã biết

- Tài liệu Tuya không thống nhất ở vài chỗ (đơn vị giờ của nhật ký, khóa lật trang, dạng kết quả người dùng); thư viện đọc cả hai dạng và báo `bad_result` nếu lạ. Cần kiểm trên máy thật khi có khóa.
- Xóa vân tay chưa gắn người dùng trên máy (không có `tuyaUserId`) chưa hỗ trợ — xóa trong app SmartLife.
- Mật khẩu tạm: Tuya xác nhận "đã nhận lệnh"; máy đồng bộ sau (`deliveryStatus`).
