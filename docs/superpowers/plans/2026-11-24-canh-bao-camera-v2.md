# Cảnh báo camera v2 — lọc nhiễu, chọn loại sự cố, gửi nhóm Zalo

> **Trạng thái:** chủ duyệt toàn bộ ngày 24/11/2026 ("đồng ý hết, cập nhật plan rồi làm toàn bộ").
> **Thay cho:** §2 (Q2, Q4, Q5, Q6), §4.2, §4.3, §4.5–§4.10 của plan 01/11 (`2026-11-01-canh-bao-camera-o-cung-kenh.md`). Các phần còn lại của plan 01/11 (bẫy B1–B6, khuôn sự cố watchdog, §3) vẫn đúng.
> **Nền:** `origin/main` ngày 24/11. PR #384 (draft, head `3ef7eae1d`, base `f2473ba4a`) chậm 508 commit, **chưa merge, chưa áp prod**. Đo prod 24/11: không có bảng `camera_alert*` và không có cron đánh giá.
> **Hạng mục riêng.** Không sửa collector trong đợt này.

## 0. Vì sao phải làm lại

Chạy luật của plan 01/11 trên dữ liệu prod 30 ngày (25/10–24/11) thì thấy nó vẫn spam:

- **1392QT có 8 kênh `DISCONNECTED` thường trực** từ 19/11 12:22. Kênh 12 và 13 tên "chua co" (chưa lắp). Mỗi lần đầu ghi có lại, cả 8 kênh mở thành sự cố mới. Kết quả là khoảng 56 sự cố kênh trong 13 ngày, cộng bản tin sáng lặp 8 dòng mỗi ngày.
- **Kênh rớt ngắn:** 1392QT có 797 lần rớt kênh, 616 lần dưới 2 phút.
- **Đầu ghi `OFFLINE` lâu đều do toà mất mạng, không do đầu ghi.** Cả ba lần đều trùng `ROUTER_UNREACHABLE` của chính toà đó:
  - 1392QT ngày 19/11: camera 10:00–12:22, router 10:21–12:26.
  - 950NK ngày 03/11: camera 13:20–14:11, router 13:43–14:15.
  - 111PVC ngày 13/11: camera 09:32–09:59, router 09:46–10:01.
- **Tối 11/11 (21:53–00:14):** nhiều toà cùng mất 1–2 phút, trùng lúc thay bản collector. Lỗi ở phía VPS, không ở từng toà.
- **Đang có lỗi mà chưa ai được báo:** 15KV kênh 3 "Ham 2" `DISCONNECTED` từ 20/11 23:06.

Chủ yêu cầu ba việc:
1. Có cơ chế lọc nhiễu để không spam, tránh mất tập trung và mất tin cậy.
2. Cho chọn loại sự cố cần thông báo.
3. Gửi Zalo theo Z1 vào nhóm **"Web nội bộ"**, và có chỗ chọn nhóm để đổi sau.

## 1. Quyết định 24/11 (đã chốt)

| # | Quyết định |
|---|---|
| D1 | **Kênh Zalo Z1.** Nick Zalo cá nhân đang kết nối của org gửi vào **một hội thoại nhóm do người dùng chọn trong cài đặt**. Lựa chọn đầu tiên là nhóm "Web nội bộ" của nick "Ihome". Migration **không** ghi cứng id hội thoại hay dữ liệu org thật: chủ tự chọn nhóm trên UI sau khi phát hành. |
| D2 | **Ngưỡng.** Đầu ghi không gọi tới được: 10 phút. Sai mật khẩu: 10 phút. Mất dữ liệu giám sát: 10 phút. Kênh mất: 15 phút. Đầu ghi trả lời lạ: 30 phút. Ổ lỗi: báo ngay. Mọi ngưỡng sửa được trong cài đặt, có cận trên và cận dưới. |
| D3 | **Ban đêm 22:00–07:00.** Loại CRITICAL báo ngay. Kênh mất phát sinh ban đêm dồn vào **tin 07:00**. |
| D4 | **Nhắc lại sự cố chưa xử lý.** Một tin gộp lúc **08:00**. 3 ngày đầu (tính theo ngày VN kể từ lúc mở) nhắc mỗi ngày, sau đó chỉ **thứ Hai**. Sự cố đã bấm "Đã biết" (`ACKNOWLEDGED`) thì thôi nhắc. |
| D5 | **Trần 6 tin Zalo mỗi ngày** cho mỗi org, chỉ đếm tin cảnh báo camera. Vượt trần thì nội dung dồn vào bản tin kế tiếp. Chuông vẫn gửi. Trần sửa được từ 1 đến 20. |
| D6 | **Tin "đã khôi phục" qua Zalo** chỉ gửi cho loại CRITICAL. Kênh lẻ khôi phục thì ghi vào bản tin sáng. |
| D7 | **Kênh 1392QT.** Kênh 12 và 13 ("chua co") tắt hẳn. Kênh 5, 11, 14, 15, 16 và kênh 10 của đầu ghi thứ hai đặt "đã biết hỏng": có trong tin hiện trạng, rồi nhắc hằng tuần đến khi sửa. Chủ tự đặt trên UI sau phát hành. |
| D8 | **Quyền sửa cài đặt**, gồm bật tắt, chế độ, loại sự cố, ngưỡng, nhóm Zalo và tắt kênh: chỉ **chủ công ty** và **superadmin**. Người có `network_center.view` ở toà đó được xem. |
| D9 | **Chuông CRM** gửi song song cho chủ công ty cộng thành viên ACTIVE có `network_center.view` ở toà đó, áp cùng luật gộp và chống lặp. **Push điện thoại để sau:** giữ đường gửi push của #384 nhưng tắt mặc định (`push_enabled=false`). |
| D10 | **Chạy thử 48 giờ (SHADOW)** trước khi gửi thật. Ở chế độ này chỉ ghi sổ "lẽ ra sẽ gửi gì", kèm nguyên văn tin Zalo, và UI cho xem sổ đó. |

## 2. Các loại sự cố và mặc định

| Mã | Nghĩa (cho người dùng) | Mức | Mặc định bật | Cách báo mặc định | Ngưỡng mặc định |
|---|---|---|---|---|---|
| `CAMERA_STORAGE_ERROR` | Ổ cứng đầu ghi báo lỗi | CRITICAL | bật | Zalo ngay, 24/7 | báo ngay |
| `CAMERA_RECORDER_OFFLINE` | Không gọi tới được đầu ghi (đầu ghi tắt hoặc toà mất mạng) | CRITICAL | bật | Zalo ngay, 24/7 | 10 phút |
| `CAMERA_RECORDER_AUTH_DENIED` | Đầu ghi từ chối mật khẩu giám sát | CRITICAL | bật | Zalo ngay, 24/7 | 10 phút |
| `CAMERA_MONITOR_STALE` | Hệ thống giám sát (VPS/collector) ngừng gửi dữ liệu | CRITICAL | bật | Zalo ngay, 24/7, **một tin cho mọi toà** | 10 phút |
| `CAMERA_CHANNEL_LOST` | Kênh camera mất hình | WARNING (≥ 50 % kênh đang theo dõi của đầu ghi cùng mất thì nâng CRITICAL) | bật | Zalo; ban đêm dồn 07:00 | 15 phút |
| `CAMERA_CHANNEL_FLAPPING` | Kênh chập chờn | INFO | bật | **chỉ bản tin 08:00** | ≥ 5 lần rớt trong 24 giờ |
| `CAMERA_RECORDER_UNKNOWN` | Đầu ghi trả lời lạ (ổ hoặc kênh không đọc được) | WARNING | bật | **chỉ chuông CRM** | 30 phút |

Mỗi loại có bốn lựa chọn cách báo: `ZALO` (Zalo + chuông), `DIGEST` (chỉ bản tin sáng + chuông), `BELL` (chỉ chuông), `OFF`.

Điều kiện, cách đóng (2 lượt sạch liên tiếp), loại trừ B2 (đầu ghi khác ONLINE thì không xét kênh và ổ) và `enabled=false` giữ như §4.2 plan 01/11.

`CAMERA_CHANNEL_FLAPPING` mới. Không mở `network_incidents` cho loại này. Bộ đánh giá đếm sự kiện `camera_events` (kind `CHANNEL`, state `DISCONNECTED`) trong 24 giờ trước giờ bản tin. Chỉ đếm khi đầu ghi đang `ONLINE`, bỏ kênh đang tắt hoặc tạm ẩn, bỏ kênh đã có `CAMERA_CHANNEL_LOST` đang mở. Kênh nào ≥ ngưỡng thì thêm một dòng vào bản tin 08:00.

## 3. Lọc nhiễu

### 3.1 Tắt báo theo từng kênh

Bảng mới `app_private.camera_alert_channel_mutes`, khoá `(recorder_id, channel)`. Có ba kiểu:

- **`IGNORE`** (không theo dõi): bộ đánh giá bỏ hẳn kênh này. Không mở sự cố, không vào bản tin, không tính vào tỉ lệ 50 %.
- **`SNOOZE`** (tạm ẩn đến ngày): giống `IGNORE` cho tới `until_at`, sau đó tự theo dõi lại.
- **`KNOWN_BROKEN`** (đã biết hỏng): vẫn mở và giữ sự cố, nhưng **không gửi tin mở hay đóng riêng**. Sự cố chỉ xuất hiện trong tin hiện trạng và bản tin nhắc **hằng tuần** (thứ Hai 08:00), bỏ qua lịch 3 ngày đầu. Khi kênh có lại thì ghi vào bản tin sáng là "đã sửa" và tự xoá dấu `KNOWN_BROKEN`.

Ghi kèm người đặt, giờ đặt và ghi chú. Sửa bằng RPC có kiểm quyền D8. Tắt một kênh đang có sự cố mở thì đóng sự cố đó với lý do `MUTED`, không gửi tin.

### 3.2 Tin hiện trạng khi bật

- Mỗi lần chuyển sang `LIVE` (từ `enabled=false` hoặc từ `SHADOW`), lượt đánh giá đầu tiên mở sự cố cho mọi điều kiện xấu đang có, **không chờ ngưỡng**, đánh dấu `observed_values.baseline=true`.
- Toàn bộ gộp thành **một** tin Zalo "Hiện trạng camera lúc bật cảnh báo".
- Sự cố hiện trạng không sinh tin mở riêng. Sau đó chúng theo lịch nhắc D4: 3 ngày đầu tính từ lúc bật, hoặc hằng tuần nếu `KNOWN_BROKEN`.

### 3.3 Gộp theo toà và theo nguyên nhân

- Mỗi lượt đánh giá, mỗi kênh gửi (một nhóm Zalo, hoặc một người nhận chuông) nhận **tối đa một tin** cho mọi sự cố mới và đã khôi phục của lượt đó.
- Trong tin, sự cố gộp **theo toà**. Ví dụ: hai đầu ghi của 1392QT cùng mất thì ghi thành một dòng "1392QT: không gọi tới được 2 đầu ghi".
- **Đầu ghi mất kèm router toà:** nếu toà có sự cố `ROUTER_UNREACHABLE` đang mở, hoặc thiết bị router của connection camera đang mất theo `network_device_current` hay nguồn tương đương, thì dòng đó ghi "**Toà X mất mạng** (router và đầu ghi đều không gọi tới được)". Nếu router vẫn kết nối ở lần kiểm gần nhất thì ghi "router vẫn kết nối lúc HH:MM ⇒ nhiều khả năng đầu ghi tắt, treo hoặc tuột dây". Chưa có số đo router mới hơn lúc đầu ghi mất thì ghi "router: chưa rõ". Router được poll thưa hơn camera, nên **không** chờ router mới gửi tin.
- **`CAMERA_MONITOR_STALE` ở ≥ 2 toà trong cùng lượt**, hoặc mọi đầu ghi đang theo dõi cùng stale: gửi một tin "Hệ thống giám sát camera ngừng gửi dữ liệu (N toà) — kiểm tra VPS/collector". Không liệt kê thành lỗi từng đầu ghi.

### 3.4 Không báo lại trong 24 giờ

- Cùng `fingerprint` đã được gửi tin mở trong vòng 24 giờ (mọi kênh gửi): tin mở mới **không** gửi.
- Sổ ghi `status='SUPPRESSED'`, `reason='REPEAT_24H'`. Sự cố vẫn mở hoặc đóng bình thường, `occurrence_count` tăng.
- Bản tin sáng ghi "tái diễn N lần trong 24 giờ qua" cho fingerprint bị chặn.
- Tin khôi phục của một lần mở đã bị chặn cũng **không** gửi.

### 3.5 Trần và dồn tin

- Trần D5 đếm theo ngày VN (`Asia/Ho_Chi_Minh`, hoặc timezone org nếu có hàm sẵn).
- Đếm tin camera đã xếp hàng gửi Zalo thật (`status` khác `SHADOW` và `SUPPRESSED`). Bản tin sáng và tin thử cũng tính vào trần. Riêng tin hiện trạng không tính.
- Tin thứ `cap` trong ngày: nếu lượt đó còn nội dung phải dồn thì thêm câu cuối "Đã chạm trần N tin hôm nay — sự cố tiếp theo xem trong CRM và bản tin sáng".
- Từ tin thứ `cap+1`: sổ ghi `status='DEFERRED'`, `reason='DAILY_CAP'`, rồi nội dung vào bản tin kế tiếp (07:00 hoặc 08:00).

### 3.6 Ban đêm và hai bản tin sáng

- **07:00 (`night_end`):** gửi các mục dồn từ đêm, gồm kênh mất phát sinh đêm (ghi rõ còn mất hay đã có lại) và các mục bị trần. Không có nội dung thì không gửi.
- **08:00 (`digest_at`):** bản tin nhắc D4, gồm:
  - sự cố mở chưa "Đã biết", theo lịch 3 ngày rồi hằng tuần;
  - kênh `KNOWN_BROKEN` (chỉ thứ Hai);
  - kênh chập chờn;
  - tái diễn bị chặn 24 giờ;
  - kênh lẻ đã khôi phục từ bản tin trước.
- Không có nội dung thì không gửi.
- Hai bản tin dùng `dedup_key` theo ngày, nên chạy lại cron không gửi trùng.

### 3.7 Kiểu tin Zalo

Tin là văn bản thuần, tiếng Việt, ngắn. Biểu tượng: `⚠` cho tin mới, `✅` cho khôi phục, `📋` cho bản tin.

Cuối tin có dòng "Xem: <URL app>/network-center/buildings/<id>?tab=cameras" nếu repo có cấu hình URL công khai của app dùng được từ SQL. Nếu không có thì ghi "Xem: CRM › Trung tâm mạng › Camera".

Không đưa vào tin: IP, mật khẩu, số serial hay số tiền. Tên kênh lấy từ `channels[].name`.

Ví dụ:

```
⚠ Camera — 2 sự cố mới
• 512TT: Ổ cứng 1 báo LỖI (08:12). Đầu ghi có thể không lưu được video.
• 15KV: Kênh 3 "Ham 2" mất hình 15 phút (từ 07:50).
```

```
⚠ 1392QT mất mạng từ 10:00 — router và 2 đầu ghi đều không gọi tới được.
```

```
✅ 1392QT: có kết nối lại lúc 12:22 (mất 2 giờ 22 phút).
```

```
📋 Camera — bản tin sáng 25/11
Đang mở, chưa ai bấm "Đã biết":
• 15KV: kênh 3 "Ham 2" mất từ 20/11 23:06 (4 ngày).
Đã biết hỏng (nhắc thứ Hai): 1392QT kênh 5, 11, 14, 15, 16; đầu ghi 2 kênh 10.
Chập chờn 24 giờ qua: 1392QT kênh 7 (12 lần).
Đêm qua: 44TL kênh 11 mất 18 phút, đã có lại 03:10.
```

## 4. Gửi Zalo (Z1)

- Theo khuôn `public.zalo_enqueue_broadcast_v1` (`supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql:314-356`):
  - chèn một `zalo_messages` (`direction='out'`, `status='pending'`, `client_dedup_key='camera_alert:<delivery-dedup-key>'`);
  - chèn một `zalo_send_queue` (`channel='personal'`, `conversation_id`, `account_id`, `message_id`, `status='queued'`);
  - cập nhật `last_message_*` của hội thoại.
- Payload phải là `{"body":…, "camera_alert":true, "camera_alert_delivery_id":…}`. **Không** dùng khoá `tu_dong`, vì khoá đó:
  - tính vào trần gửi phòng trống;
  - bị worker kiểm `STALE_SALE_CONTENT`;
  - bị "dừng khẩn cấp" của bot đăng phòng huỷ.
- Phải đọc `worker/lib/queue.js`, `worker/lib/automation.js` và `worker/lib/scope-guard.js` để chứng minh worker hiện tại gửi đúng job văn bản này như một tin gửi tay. Nếu worker cần sửa thì **dừng và báo**, không tự sửa worker trong đợt này.
- Hàm xếp hàng là `app_private` SECURITY DEFINER, chỉ bộ đánh giá gọi.
- Trước khi xếp hàng, kiểm:
  - hội thoại còn tồn tại, cùng org, `thread_type='group'`;
  - tài khoản là `kind='personal'` và `status='connected'`.
- Sai điều kiện thì sổ ghi `FAILED` kèm lý do tiếng Việt, chuông vẫn gửi, và UI cài đặt hiện cảnh báo "Nick Zalo chưa kết nối" hoặc "Nhóm không còn".
- Sổ `camera_alert_deliveries` lưu `zalo_job_id`. UI đọc trạng thái job (`sent`/`failed` + `last_error`) để hiện "đã gửi" hay "lỗi gửi".
- **Tin thử:** RPC `…_send_test_v1` (quyền D8) xếp hàng một tin "Tin thử cảnh báo camera — nếu nhóm nhận được tin này là cấu hình đúng". Tin thử tính vào trần.

## 5. Cài đặt (thay §4.3 `camera_alert_settings`)

Mỗi org một dòng:

| Cột | Giá trị |
|---|---|
| `enabled` | mặc định `false` |
| `mode` | `SHADOW` hoặc `LIVE`, mặc định `SHADOW` |
| `zalo_account_id`, `zalo_conversation_id` | NULL được |
| `types` | jsonb, theo mã: `{enabled, delivery: ZALO\|DIGEST\|BELL\|OFF, threshold_seconds}`, mặc định theo §2 |
| `night_start`, `night_end`, `digest_at` | 22:00, 07:00, 08:00 |
| `daily_zalo_cap` | 6 |
| `push_enabled` | `false` |
| `live_since` | dùng cho tin hiện trạng |
| `updated_by`, `updated_at`, `version` | `version` để CAS; cập nhật lệch trả `PT409` theo quy ước repo |

**RPC đọc và ghi** (prefix theo quy ước Network Center):

- **`get`:**
  - Ai có `network_center.view` ở ít nhất một toà của org thì gọi được.
  - Trả cài đặt, `can_edit`, tên nick và nhóm đang chọn cùng trạng thái kết nối, số tin đã gửi hôm nay so với trần.
- **`save`:**
  - Chỉ chủ công ty hoặc superadmin. Validate cận: ngưỡng 60–86 400 giây, trần 1–20, giờ hợp lệ.
  - Đổi `mode` hoặc `enabled` ghi audit.
- **`list_zalo_groups`:**
  - Quyền như `save`.
  - Trả hội thoại `thread_type='group'` của các nick `personal` + `connected` trong org (id, tên nhóm, nick, tin cuối).
  - Có tìm theo tên. Không trả nội dung tin.
- **`set_channel_mute`, `clear_channel_mute`:**
  - Quyền như `save`.
  - Kiểm đầu ghi thuộc org và kênh có trong snapshot.
- **`list_deliveries`:**
  - Quyền như `get`, nhưng chỉ trả dòng thuộc toà người đó xem được. Tin gộp nhiều toà chỉ hiện với người xem được mọi toà trong tin, hoặc chủ công ty và superadmin.
  - Trả sổ 7 ngày gần nhất: giờ, loại (mở / khôi phục / hiện trạng / bản tin / thử), kênh gửi, trạng thái (`SHADOW` / `QUEUED` / `SENT` / `FAILED` / `SUPPRESSED` / `DEFERRED`), lý do, nguyên văn tin Zalo.
- Đọc sự cố camera đang mở theo toà: giữ RPC của #384. Thêm acknowledge nếu `IncidentsTab` chưa có đường acknowledge dùng được; phải tra trước, có rồi thì dùng lại.

Chủ công ty dùng khuôn `app_private.ie_actor_is_company_owner_v1`. Superadmin dùng đúng hàm kiểm superadmin hiện có, phải tra, không tự viết.

## 6. Giao diện

- **Cài đặt cảnh báo camera:** cấp org, đặt trong Trung tâm mạng. Agent chọn chỗ hợp với điều hướng hiện có và ghi lý do. Gồm:
  - Công tắc bật và chế độ "Chạy thử (không gửi)" / "Gửi thật". Chuyển sang "Gửi thật" phải có hộp xác nhận, nói rõ sẽ gửi tin hiện trạng vào nhóm.
  - Nơi nhận Zalo: chọn nick rồi chọn nhóm (tìm theo tên), nút "Gửi tin thử", cảnh báo khi nick mất kết nối.
  - Bảng loại sự cố: tên dễ hiểu (cột "Nghĩa" ở §2), công tắc, cách báo (Zalo / Chỉ bản tin sáng / Chỉ chuông / Tắt), ngưỡng phút.
  - Giờ đêm, giờ bản tin, trần tin mỗi ngày, số tin đã gửi hôm nay.
  - **Nhật ký gửi:** danh sách từ `list_deliveries`, lọc theo trạng thái, xem nguyên văn tin. Đây là nơi chủ đọc kết quả chạy thử 48 giờ.
  - Người không có quyền sửa thì chỉ xem, các ô bị khoá, và có dòng "Chỉ chủ công ty hoặc superadmin sửa được".
- **Tab Camera của toà:** giữ banner đỏ ổ lỗi và dải "Sự cố đang mở" của #384, và thêm:
  - Mỗi kênh có menu "Không theo dõi kênh này" / "Tạm ẩn đến…" / "Đã biết hỏng (nhắc hằng tuần)" / "Theo dõi lại".
  - Badge hiện trạng thái tắt, kèm người đặt và ngày.
  - Nút "Đã biết" trên sự cố đang mở.
- **Chuông:** bấm vào thì mở đúng tab Camera của toà (giữ `notificationRoutes` của #384).
- Theo §14 Contract: shadcn/Lucide, React Hook Form + Zod, dữ liệu qua hook và repository typed, phân biệt lỗi quyền, validation và `PT409`. Có chế độ demo (`cameraDemo.ts`) cho màn mới.

## 7. Bộ đánh giá (thay §4.6–§4.8)

- Một cron `*/2` duy nhất gọi `app_private.camera_alert_evaluate_v1(now)`, dùng advisory lock.
- Mỗi lượt làm theo thứ tự:
  1. tính điều kiện;
  2. mở hoặc đóng sự cố (bỏ kênh `IGNORE`/`SNOOZE`);
  3. xếp nội dung theo §3: gộp, chặn 24 giờ, đêm, trần, `KNOWN_BROKEN`;
  4. nếu đến giờ thì chạy bản tin 07:00 hoặc 08:00;
  5. ghi sổ và gửi theo `mode`.
- `SHADOW`:
  - không mở `network_incidents`, không chèn chuông, không xếp hàng Zalo;
  - sổ ghi đủ "lẽ ra" kèm nguyên văn tin, kể cả tin hiện trạng *dự kiến* lúc chuyển `LIVE`.
- Hàm `now` tiêm được để test kiểm giờ đêm, thứ Hai, 24 giờ, và ngày 1–3.
- Tắt khẩn và rollback giữ như §4.8 plan 01/11.

## 8. Kiểm thử bắt buộc

**SQL runtime trên DB dùng một lần** (`scripts/test-network-center-camera-disposable.mjs` + file `scripts/__tests__/network-center-camera-alerts-*.sql`). Mỗi mục một ca có assert:

1. Ngưỡng từng loại và trễ đóng 2 lượt.
2. B2: đầu ghi OFFLINE thì không mở sự cố kênh hay ổ.
3. `IGNORE`, `SNOOZE` (hết hạn thì theo dõi lại) và `KNOWN_BROKEN` (chỉ nhắc thứ Hai, có lại thì xoá dấu).
4. **Kịch bản 1392QT:**
   - 2 đầu ghi, 8 kênh mất thường trực, đầu ghi rớt và có lại 5 lần trong 13 ngày, kênh 12 và 13 `IGNORE`, 6 kênh `KNOWN_BROKEN`.
   - Kỳ vọng: 1 tin hiện trạng, không có tin mở hay đóng kênh nào, nhắc kênh chỉ vào thứ Hai.
5. Gộp theo toà (2 đầu ghi, 1 dòng). Phân biệt router mất, router còn kết nối, router chưa rõ.
6. Stale ≥ 2 toà ra một tin.
7. Chặn 24 giờ: mở, đóng rồi mở lại trong 24 giờ thì `SUPPRESSED`; sau 24 giờ thì gửi.
8. Đêm: kênh mất lúc 23:00 vào tin 07:00; ổ lỗi lúc 23:00 gửi ngay.
9. Nhắc: ngày 1, 2, 3 có nhắc; ngày 4–6 không; thứ Hai có. Sau "Đã biết" thì hết nhắc.
10. Trần 6: tin thứ 6 có câu báo trần, tin thứ 7 `DEFERRED` và vào bản tin kế tiếp. Chuông vẫn gửi.
11. Khôi phục: Zalo chỉ cho CRITICAL; kênh lẻ khôi phục vào bản tin.
12. Chập chờn: ≥ 5 lần rớt vào bản tin 08:00; dưới 5 thì không; kênh `IGNORE` thì không.
13. SHADOW: không có `network_incidents`, `notifications` hay `zalo_send_queue` mới, sổ có nguyên văn tin. Chuyển sang LIVE ra đúng một tin hiện trạng.
14. Hình dạng job Zalo: có `zalo_messages` + `zalo_send_queue`, payload không có `tu_dong`, `conversation_id`/`account_id` khớp. Nick ngắt kết nối thì sổ `FAILED` và chuông vẫn gửi.
15. Quyền:
    - chủ công ty và superadmin sửa được;
    - quản lý có `network_center.view` chỉ đọc (42501 khi ghi);
    - org khác bị chặn;
    - `anon` và `authenticated` không gọi được hàm `app_private`;
    - CAS lệch trả `PT409`.
16. Idempotent: chạy lại cùng `now` không sinh tin trùng. Bản tin trong ngày không gửi hai lần.

**Kiểm đột biến** cho quyền và cách ly org theo Contract §8: lật từng nhánh kiểm quyền thì test phải đỏ.

**Vitest** cho màn cài đặt và menu kênh: quyền xem/sửa, lỗi `PT409`, validation, demo.

**Playwright MCP**: kiểm màn cài đặt và tab Camera bị đổi ở viewport máy tính và điện thoại (390 px). Lưu ảnh và console.

## 9. Phát hành (mỗi bước hỏi chủ trước)

1. Merge PR. Đóng #384 vì đã được thay.
2. `migrate:forward` lên prod.
3. Promote UI. **Sau** bước 2, nếu không tab Camera lỗi (bẫy §7 plan 01/11).
4. Chủ (hoặc agent theo lệnh chủ) vào màn cài đặt:
   - chọn nhóm "Web nội bộ" và bấm "Gửi tin thử";
   - đặt kênh 1392QT theo D7;
   - bật ở chế độ "Chạy thử".
5. Sau 48 giờ, đọc nhật ký gửi cùng chủ: số tin dự kiến, chỗ còn nhiễu.
6. Chủ duyệt thì chuyển "Gửi thật". Nhóm nhận đúng một tin hiện trạng.

## 10. Ngoài phạm vi đợt này

- Sửa collector:
  - kiểm còn ghi hình (C7);
  - đo router ngay lúc đầu ghi mất để phân biệt chắc chắn toà mất mạng hay đầu ghi tắt;
  - luồng SD treo.
- Push điện thoại (D9).
- Hermes DM (Z2).
- Cảnh báo router/WAN riêng. `ROUTER_UNREACHABLE` hiện chỉ được đọc để ghi nguyên nhân.
