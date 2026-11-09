# iHome Điểm danh cho Android

App cài trên điện thoại Android của quản lý (Android 8 trở lên). App tự ghi vị trí GPS theo các mốc 15/30/60 phút trong khung giờ chủ công ty đặt, kể cả khi khóa màn hình, rồi gửi về CRM. Không phải bấm mỗi lần. Ngoài khung giờ app không lấy vị trí, chỉ gửi tình trạng máy (pin, quyền, không có toạ độ) khoảng mỗi 15 phút.

Bản build quyết định máy chủ, người dùng không nhập địa chỉ. Bản thử (`debug`) có hậu tố `.thu`, tên «iHome Điểm danh (thử)», trỏ project TEST, nên cài song song được với bản thật.

## Ghép nối

1. Trên CRM mở **Hôm nay → Điểm danh tự động → Ghép máy** để lấy mã 10 ký tự. Mã dùng một lần, hạn 10 phút.
2. Bấm liên kết `ihomediemdanh://pair?c=…` ngay trên điện thoại, hoặc mở app rồi gõ mã.
3. Bấm **Ghép nối**. Liên kết chỉ điền sẵn mã; người cầm máy phải tự bấm xác nhận.

Mỗi người một máy đang hoạt động. Ghép máy mới thì máy cũ bị gỡ, và các mốc chưa gửi của lần ghép trước không được chuyển sang tài khoản mới. Token do app tự sinh, chỉ nằm trong bộ nhớ mã hóa của máy; máy chủ chỉ giữ SHA-256 của token.

## Quyền cần cấp

App không có màn hình đồng ý; chỉ có các hộp thoại quyền của Android. App hướng dẫn từng bước theo thứ tự:

| Bước | Android | Cần bấm |
|---|---|---|
| Thông báo | 13 trở lên | Cho phép |
| Vị trí | mọi bản | Vị trí chính xác, Khi dùng ứng dụng |
| Vị trí nền | 10 trở lên | **Luôn cho phép** (Allow all the time) |
| Tiết kiệm pin | mọi bản | Cho phép (Không tối ưu hóa pin) |
| Báo thức đúng giờ | 12, 12L | Bật «Cho phép đặt báo thức và lời nhắc» |

Quyền khai báo đúng theo plan 4.6. `WAKE_LOCK` và `ACCESS_NETWORK_STATE` do thư viện `androidx.work` thêm khi gộp manifest; CI đối chiếu danh sách quyền trong APK với danh sách đã duyệt.

## Cài đặt pin theo hãng

Android gốc chưa đủ: nhiều hãng tự tắt app chạy nền. Ngoài bước «Tiết kiệm pin» trong app, cần làm thêm:

- **Xiaomi / Redmi (MIUI, HyperOS):** Cài đặt → Ứng dụng → iHome Điểm danh → Tiết kiệm pin → **Không hạn chế**; bật **Tự khởi chạy**. Mở màn đa nhiệm, nhấn giữ app, bấm biểu tượng khóa để ghim app.
- **Oppo / Realme (ColorOS):** Cài đặt → Pin → Mức tiêu thụ pin của ứng dụng → iHome Điểm danh → bật **Cho phép hoạt động nền** và **Cho phép tự khởi động**. Tắt **Tối ưu hóa ứng dụng ngủ**. Ghim app trong màn đa nhiệm.
- **Samsung (One UI):** Cài đặt → Chăm sóc thiết bị → Pin → Giới hạn sử dụng trong nền → đảm bảo app **không** nằm trong «Ứng dụng ngủ» hay «Ứng dụng ngủ sâu»; thêm vào **Ứng dụng không bao giờ ngủ**. Trong thông tin ứng dụng, chọn Pin → **Không hạn chế**.

Đóng app bằng «Buộc dừng» sẽ xóa báo thức cho tới khi mở lại app.

## Cách hoạt động

- `SlotScheduler` chỉ giữ một báo thức cho mốc kế tiếp (`setExactAndAllowWhileIdle`). Không có mốc thì không có báo thức. Mốc tính theo giờ Việt Nam và giờ máy đã chỉnh theo giờ máy chủ.
- `CaptureService` là dịch vụ nền trước loại `location`, sống tối đa 45 giây. Nếu máy có nguồn `fused` thì dùng nguồn đó, không thì GPS và mạng song song, lấy kết quả chính xác nhất. Hết giờ thì dùng vị trí gần nhất trong máy nếu chưa quá 60 phút, báo là `stale` kèm tuổi; cũ hơn thì không gửi toạ độ.
- Không lấy được thì ghi `none` với lý do `permission_denied`, `location_off`, `timeout`, `paused`. Khi tạm dừng, app không lấy vị trí.
- Mỗi mốc được lưu mã hóa (AES-GCM, khóa AndroidKeyStore) trước khi gửi. Mất mạng thì giữ lại, tối đa 15 ngày vì máy chủ không nhận bản ghi quá 14 ngày.
- `DeliveryWork` chỉ coi là đã gửi khi biên nhận JSON đúng `schemaVersion:1`, `ok:true`, `externalId` trùng `id`, trạng thái hợp lệ, có `acceptedAt` và `settings`. Khi chính cổng nhận trả 401, máy đã bị gỡ: app dừng hẳn và báo trên màn hình. Khi cổng nhận trả 403 (tài khoản không còn hoạt động, hoặc máy chủ mất quyền), app ngừng lấy vị trí nhưng vẫn báo tình trạng máy và tự chạy lại khi có biên nhận hợp lệ. 401/403 từ lớp trung gian thì chỉ thử lại.
- `SafetyNetWork` chạy khoảng mỗi 15 phút, đặt lại báo thức nếu mất và gửi `device.state`. Android có thể hoãn việc này khi máy ngủ.

## Build và kiểm chứng

Công cụ ghim giống iHome Gateway: JDK 17, Gradle 8.11.1, AGP 8.9.2, Android SDK Platform 35, Build Tools 35.0.0.

```powershell
.\build.ps1 -JavaHome "<JDK17>" -AndroidSdk "<SDK>"
```

Workflow `android-diem-danh.yml` chạy `ci-build.sh` (unit test, lint, APK, đối chiếu quyền trong APK) và `ci-device.sh` (emulator Android 15 và Android 10). Artifact `ihome-diem-danh-<sha>` chứa APK bản thử và bằng chứng. Chỉ nhánh `main` mới ký APK phát hành bằng khóa của Gateway (alias `ihome-gateway`).

**CI chứng minh được:**

- Tính mốc đúng ở biên khung giờ, ngày nghỉ, giờ Việt Nam; `id` ổn định; gói gửi đúng khóa như máy chủ; biên nhận sai không được tính là đã gửi (JUnit).
- Hàng đợi mã hóa còn nguyên sau khi tắt hẳn tiến trình và mở lại; 401 dừng mọi thứ; 403 ngừng lấy vị trí rồi tự chạy lại khi có biên nhận; báo thức chỉ đặt cho mốc trong khung, không đặt cho ngày nghỉ, được đặt lại sau khởi động giả lập; dịch vụ tạo đúng gói từ vị trí giả lập, gói `paused` và `location_off`; bản cài mới chưa có quyền thì hiện đúng bước đầu của luồng cấp quyền; ảnh màn hình ghép nối, cấp quyền, trạng thái (emulator).

**CI không chứng minh được:**

- Hành vi chạy nền trên máy thật: báo thức có đúng giờ khi máy ngủ sâu không, dịch vụ `location` có chạy được từ báo thức trên Android 14/15 ngoài đời không, trình diệt app của Xiaomi/Oppo/Samsung có tắt app không. Emulator không có các lớp này. Cần đo hai ngày trên máy thật (bước G0 của plan).
- Quyền `permission_denied` chỉ kiểm ở tầng quy tắc: trên emulator, thu hồi quyền sẽ giết tiến trình kiểm thử.
- Gọi máy chủ thật: test dùng đường truyền giả, chưa gọi TEST hay production.
