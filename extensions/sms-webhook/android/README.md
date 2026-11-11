# iHome Gateway cho Android

Một app Android (8 trở lên) gồm hai phần, mỗi phần một thẻ trên màn hình đầu:

- **Điểm danh:** tự ghi vị trí GPS của quản lý theo các mốc 15/30/60 phút trong khung giờ chủ công ty đặt, kể cả khi khóa màn hình, rồi gửi về CRM.
- **Biến động số dư:** chuyển SMS mới và thông báo mới/cập nhật của các app đã chọn đến nguồn nhận trong iHome CRM. Chỉ dành cho máy được giao nhận tin ngân hàng. App không đọc hộp thư cũ, đăng nhập ngân hàng, tự ghi sổ hoặc gửi email.

Từ bản 2.0.0, app «iHome Điểm danh» riêng (`vn.ihome.diemdanh`, bản 1.0.x) được gộp vào đây. `applicationId` vẫn là `vn.ihome.smsgateway` và khóa ký không đổi, nên bản 2.0.0 cài đè lên Gateway 0.2.0, giữ cấu hình, hàng đợi và quyền đã cấp của phần Biến động số dư. Mã nguồn phần Điểm danh nằm ở gói Java `vn.ihome.diemdanh` trong cùng project này.

## Cài app

**Google Play Protect chặn cài APK này khi mở file từ trình duyệt hoặc trình quản lý tệp**, vì app khai báo quyền `RECEIVE_SMS` và một dịch vụ đọc thông báo (notification listener). Gateway 0.2.0 đã bị chặn như vậy. Từ bản 2.0.0 điều này áp dụng cho mọi máy cài app, kể cả máy chỉ dùng Điểm danh: quyền được khai báo trong APK dù người dùng không bật phần Biến động số dư. Chưa kiểm trên máy thật cách cài nào qua được lớp chặn này với bản 2.0.0.

Máy đang dùng «iHome Điểm danh» 1.0.x: đó là app khác, dữ liệu không tự chuyển sang. Cài iHome Gateway, ghép máy lại bằng mã mới (xem dưới), rồi gỡ app cũ. Khi còn cả hai app, cả hai cùng nhận liên kết ghép máy nên Android có thể hỏi mở bằng app nào; chọn iHome Gateway.

## Màn hình đầu

Mở app thấy tên app, phiên bản đang cài và hai thẻ **Điểm danh**, **Biến động số dư**, mỗi thẻ một dòng trạng thái. Bấm thẻ để vào phần đó; bấm Quay lại để về màn hình đầu.

- Màn hình đầu không xin quyền nào. Mỗi phần chỉ xin quyền của mình, ở màn của mình, khi người dùng bấm thiết lập. Máy chỉ dùng một phần không bị hỏi quyền của phần kia.
- Với máy đã ghép điểm danh, mở app (chỉ cần tới màn hình đầu) cũng đặt lại báo thức mốc kế tiếp và các việc nền nếu bị mất, giống như mở màn Điểm danh. Máy chưa ghép thì không có báo thức hay việc nền nào được đặt.
- Với máy đang bật chuyển tiếp, mở app cũng lên lịch lại việc gửi hàng đợi và gửi một heartbeat, như màn Biến động số dư vẫn làm khi mở.

## Phần Điểm danh

Ngoài khung giờ app không lấy vị trí, chỉ gửi tình trạng máy (pin, quyền, không có toạ độ) khoảng mỗi 15 phút. Bản build quyết định máy chủ, người dùng không nhập địa chỉ.

### Ghép nối

1. Trên CRM mở **Hôm nay → Điểm danh tự động → Ghép máy** để lấy mã 10 ký tự. Mã dùng một lần, hạn 10 phút.
2. Bấm liên kết `ihomediemdanh://pair?c=…` ngay trên điện thoại, hoặc mở app, vào thẻ **Điểm danh** rồi gõ mã.
3. Bấm **Ghép nối**. Liên kết chỉ điền sẵn mã; người cầm máy phải tự bấm xác nhận.

Mỗi người một máy đang hoạt động. Ghép máy mới thì máy cũ bị gỡ, và các mốc chưa gửi của lần ghép trước không được chuyển sang tài khoản mới. Token do app tự sinh, chỉ nằm trong bộ nhớ mã hóa của máy; máy chủ chỉ giữ SHA-256 của token.

### Quyền cần cấp

App không có màn hình đồng ý; chỉ có các hộp thoại quyền của Android. Màn Điểm danh hướng dẫn từng bước theo thứ tự:

| Bước | Android | Cần bấm |
|---|---|---|
| Thông báo | 13 trở lên | Cho phép |
| Vị trí | mọi bản | Vị trí chính xác, Khi dùng ứng dụng |
| Vị trí nền | 10 trở lên | **Luôn cho phép** (Allow all the time) |
| Tiết kiệm pin | mọi bản | Cho phép (Không tối ưu hóa pin) |
| Báo thức đúng giờ | 12, 12L | Bật «Cho phép đặt báo thức và lời nhắc» |

### Cài đặt pin theo hãng

Android gốc chưa đủ: nhiều hãng tự tắt app chạy nền. Ngoài bước «Tiết kiệm pin» trong app, cần làm thêm:

- **Xiaomi / Redmi (MIUI, HyperOS):** Cài đặt → Ứng dụng → iHome Gateway → Tiết kiệm pin → **Không hạn chế**; bật **Tự khởi chạy**. Mở màn đa nhiệm, nhấn giữ app, bấm biểu tượng khóa để ghim app.
- **Oppo / Realme (ColorOS):** Cài đặt → Pin → Mức tiêu thụ pin của ứng dụng → iHome Gateway → bật **Cho phép hoạt động nền** và **Cho phép tự khởi động**. Tắt **Tối ưu hóa ứng dụng ngủ**. Ghim app trong màn đa nhiệm.
- **Samsung (One UI):** Cài đặt → Chăm sóc thiết bị → Pin → Giới hạn sử dụng trong nền → đảm bảo app **không** nằm trong «Ứng dụng ngủ» hay «Ứng dụng ngủ sâu»; thêm vào **Ứng dụng không bao giờ ngủ**. Trong thông tin ứng dụng, chọn Pin → **Không hạn chế**.

Đóng app bằng «Buộc dừng» sẽ xóa báo thức cho tới khi mở lại app, và phần Biến động số dư cũng ngừng nhận cho tới lúc đó.

### Cách hoạt động

- `SlotScheduler` chỉ giữ một báo thức cho mốc kế tiếp (`setExactAndAllowWhileIdle`). Không có mốc thì không có báo thức. Mốc tính theo giờ Việt Nam và giờ máy đã chỉnh theo giờ máy chủ.
- `CaptureService` là dịch vụ nền trước loại `location`, nghe tối đa 38 giây. Luôn nghe thụ động (`passive`) và gọi nguồn `fused` theo tên; Android dưới 12 hoặc máy không có `fused` thì gọi GPS và mạng ngay, còn lại gọi thêm sau 15 giây nếu chưa có vị trí đủ tốt. Chỉ vị trí lấy được trong chính lần ghi mới là `fresh`, lấy kết quả chính xác nhất. Hết giờ mà chưa có thì dùng vị trí gần nhất trong máy nếu chưa quá 60 phút, báo là `stale` kèm tuổi; cũ hơn thì không gửi toạ độ. Riêng khi đồng hồ hết giờ chạy trễ (app vừa bị đóng băng) thì chờ thêm khoảng 1,5 giây cho các vị trí đang xếp hàng. Tới giây 45 mà chưa ghi thì vẫn ghi mốc theo cách trên, không bỏ mốc; dịch vụ dừng chậm nhất ở giây 50. Mỗi mốc gửi kèm khối `diag` (báo thức trễ bao lâu, nguồn nào trả lời, kết thúc ra sao) để chẩn đoán.
- Không lấy được thì ghi `none` với lý do `permission_denied`, `location_off`, `timeout`, `paused`. Khi tạm dừng, app không lấy vị trí.
- Mỗi mốc được lưu mã hóa (AES-GCM, khóa AndroidKeyStore) trước khi gửi. Mất mạng thì giữ lại, tối đa 15 ngày vì máy chủ không nhận bản ghi quá 14 ngày.
- `DeliveryWork` chỉ coi là đã gửi khi biên nhận JSON đúng `schemaVersion:1`, `ok:true`, `externalId` trùng `id`, trạng thái hợp lệ, có `acceptedAt` và `settings`. Khi chính cổng nhận trả 401, máy đã bị gỡ: phần Điểm danh dừng hẳn và báo trên màn hình. Khi cổng nhận trả 403 (tài khoản không còn hoạt động, hoặc máy chủ mất quyền), app ngừng lấy vị trí nhưng vẫn báo tình trạng máy và tự chạy lại khi có biên nhận hợp lệ. 401/403 từ lớp trung gian thì chỉ thử lại.
- `SafetyNetWork` chạy khoảng mỗi 15 phút, đặt lại báo thức nếu mất và gửi `device.state`. Android có thể hoãn việc này khi máy ngủ.

Hai phần dùng tên lưu trữ riêng (tệp cấu hình, cơ sở dữ liệu hàng đợi, khóa AndroidKeyStore, tên việc WorkManager), không dùng chung dữ liệu của nhau.

## Phần Biến động số dư

### Kết nối

1. Trên CRM mở **Biến động số dư → Nguồn kết nối → Thêm nguồn**. Lấy URL HTTPS và mã kết nối riêng cho nguồn.
2. Cài APK, mở **iHome Gateway**, vào thẻ **Biến động số dư**, nhập URL và mã kết nối.
3. Chọn SMS và/hoặc các app ngân hàng. Cấp quyền nhận SMS hoặc Truy cập thông báo tương ứng.
4. Bấm **Bật chuyển tiếp**, rồi **Kiểm tra kết nối ngay**. Trạng thái chỉ xác nhận khi nhận được biên nhận hợp lệ của CRM.

SMS được chuyển toàn bộ, gồm cả OTP và tin cá nhân. Android/ngân hàng có thể ẩn nội dung thông báo; app không vượt qua cơ chế này. Giữ điện thoại có Internet, sóng SIM nếu dùng SMS và cho phép chạy nền theo cài đặt của hãng.

App gửi `gateway.heartbeat` khoảng mỗi 15 phút khi bật, cùng trạng thái quyền và phiên bản app. Android có thể trì hoãn công việc nền; không có SMS mới không đồng nghĩa điện thoại đã mất kết nối. Bấm Tạm dừng sẽ ngừng nhận/gửi tiếp; yêu cầu đang gửi có thể đã tới máy chủ.

### Dữ liệu và biên nhận

- Cấu hình/mã kết nối và nội dung chờ gửi được mã hóa bằng AES-GCM với khóa AndroidKeyStore; tắt backup và truyền thiết bị.
- Mỗi tin có ID ổn định, hàng đợi được lưu trước khi gửi. Mạng lỗi, HTTP 408/429/5xx được thử lại. Lỗi khác giữ dữ liệu để người dùng xử lý/thử lại/xóa.
- Chỉ chấp nhận biên nhận JSON `schemaVersion:1`, `ok:true`, có `data.externalId` trùng ID yêu cầu, `sourceId` UUID đúng nguồn đã ghép, loại trạng thái và `acceptedAt` hợp lệ. HTTP 2xx rỗng/HTML không được tính là đã gửi.
- Tin đã xác nhận được bỏ nội dung khỏi hàng đợi; giữ tối đa 100 trạng thái thành công gần nhất. Nội dung tối đa 8192 byte UTF-8; toàn bộ JSON tối đa 64 KiB.
- Hàng đợi gắn với cả URL và mã kết nối của nguồn. **Đổi/thu hồi mã khi hàng đợi đã gửi hết**, hoặc chủ động xóa tin chưa gửi. App không tự chuyển tin của nguồn cũ sang nguồn mới. Cấu hình mới xóa ghép `sourceId` cũ để xác nhận lại từ CRM.

## Build và kiểm chứng

Runtime được ghim trong Gradle: JDK 17, Gradle 8.11.1, AGP 8.9.2, Android SDK Platform 35 và Build Tools 35.0.0. Không đặt mã kết nối thật vào source hoặc CI.

Trên Windows đã có SDK được cấp phép:

```powershell
.\build.ps1 -JavaHome "<JDK17>" -AndroidSdk "<SDK>"
```

Bản thử (`debug`) có hậu tố `.thu` (`vn.ihome.smsgateway.thu`), tên «iHome Gateway (thử)», phần Điểm danh trỏ project TEST, nên cài song song được với bản thật. APK debug ở `app/build/outputs/apk/debug/app-debug.apk`, chỉ để cài thử nội bộ.

Workflow `android-gateway.yml` (**Android Gateway**) là nơi duy nhất build và kiểm app; artifact `ihome-bank-gateway-<sha>` chứa APK bản thử và bằng chứng.

- `ci-build.sh`: chạy unit test của cả hai phần (`GatewayPolicyTest`, `CheckinPolicyTest`) và kiểm mọi test khai báo đều đã chạy, không bỏ qua; chạy Android lint; tạo APK và test APK; đối chiếu danh sách quyền trong APK với danh sách đã duyệt (`RECEIVE_SMS` của Biến động số dư, các quyền vị trí/báo thức/pin của Điểm danh, cộng `WAKE_LOCK` và `ACCESS_NETWORK_STATE` do thư viện `androidx.work` thêm khi gộp manifest). Script kiểm thành phần SDK tồn tại và tắt tải SDK tự động; không chấp nhận thỏa thuận thay người dùng. Bằng chứng ở `build/ci-evidence/` (`jvm-suites.txt`, `apk-sha256.txt`, `apk-signature.txt`, `apk-badging.txt`, `apk-permissions*.txt`).
- `ci-device.sh`: cần emulator, KVM và hai image `system-images;android-35;google_apis;x86_64`, `system-images;android-29;google_apis;x86_64` đã cài. Trên Android 15 chạy cả ba bộ `GatewayDeviceTest`, `DiemDanhDeviceTest`, `HomeDeviceTest`; trên Android 10 chạy `DiemDanhDeviceTest` và `HomeDeviceTest` (bộ Biến động số dư chỉ kiểm trên Android 15 như trước). Sau đó cài lại app sạch trên từng bản Android và chạy từng bước trong tiến trình riêng: màn hình đầu của bản cài mới (`HomeCleanInstallProbe`), rồi ghi hàng đợi – tắt hẳn tiến trình – đọc lại, và các bước cấp quyền của máy chưa cấp gì (`CleanInstallProbe`). Bằng chứng từng bản Android ở `build/ci-evidence/android-<api>/`: kết quả test, ảnh `diemdanh-*.png` và `gateway-*.png`, `clean-install-*.txt`, `alarm-dump.txt`. Thiếu emulator/image là kiểm chưa đạt, không tự coi là pass.

**CI chứng minh được:**

- Điểm danh, tầng quy tắc (JUnit): tính mốc đúng ở biên khung giờ, ngày nghỉ, giờ Việt Nam; `id` ổn định; gói gửi đúng khóa như máy chủ; biên nhận sai không được tính là đã gửi.
- Điểm danh, trên emulator: hàng đợi mã hóa còn nguyên sau khi tắt hẳn tiến trình và mở lại; 401 dừng mọi thứ; 403 ngừng lấy vị trí rồi tự chạy lại khi có biên nhận; báo thức chỉ đặt cho mốc trong khung, không đặt cho ngày nghỉ, được đặt lại sau khởi động hoặc cài bản mới đè lên (giả lập); dịch vụ tạo đúng gói từ vị trí giả lập kèm khối `diag`, gói `paused` và `location_off`; bản cài mới chưa có quyền thì hiện đúng bước đầu của luồng cấp quyền; ảnh màn hình ghép nối, cấp quyền, trạng thái.
- Biến động số dư: URL/token, UTF-8, ID, retry, giới hạn JSON, gắn nguồn và biên nhận (JUnit); AndroidKeyStore/hàng đợi, heartbeat, đổi nguồn, biên nhận và giao diện trên emulator Android 15.
- Phần gộp, trên emulator: app chỉ có một biểu tượng và nó mở màn hình đầu; liên kết `ihomediemdanh://pair?c=…` mở màn ghép nối của chính app này; máy chưa ghép, chưa cấu hình thấy đủ hai thẻ và không có báo thức; máy đã ghép mở màn hình đầu thì báo thức bị mất được đặt lại; thiếu điều kiện (tắt vị trí) thì thẻ báo còn thiếu quyền; mỗi thẻ mở đúng màn của mình và Quay lại về màn hình đầu; bản cài mới mở màn hình đầu không bị xin quyền nào, không có báo thức và không có việc nền nào được đặt.

**CI không chứng minh được:**

- Cài đè bản 2.0.0 lên Gateway 0.2.0 trên máy thật, và việc Play Protect xử lý file cài ra sao.
- Hành vi chạy nền trên máy thật: báo thức có đúng giờ khi máy ngủ sâu không, dịch vụ `location` có chạy được từ báo thức trên Android 14/15 ngoài đời không, trình diệt app của Xiaomi/Oppo/Samsung có tắt app không. Emulator không có các lớp này.
- Quyền `permission_denied` chỉ kiểm ở tầng quy tắc: trên emulator, thu hồi quyền sẽ giết tiến trình kiểm thử.
- Gọi máy chủ thật: test dùng đường truyền giả, chưa gọi TEST hay production.
- Nhận SMS/thông báo ngân hàng thật; trạng thái «Đã bật chuyển tiếp» trên màn hình đầu (test không bật chuyển tiếp).

## APK phát hành

`ci-release.sh` tạo `app/build/outputs/apk/release/app-release.apk` bằng khóa riêng, alias cố định `ihome-gateway`. Chỉ chạy bước ký trên nhánh `main` đã tin cậy; không cung cấp khóa cho pull request. CI cần hai secret `IHOME_BANK_ANDROID_KEYSTORE_B64` và `IHOME_BANK_ANDROID_PASSWORD` (cùng mật khẩu cho kho và khóa). Thiếu secret hoặc thiếu JDK 17/SDK 35 thì dừng, không sinh APK chưa ký thay thế. APK đã ký nằm trong artifact `ihome-bank-gateway-release-<sha>`.

Script giải mã kho khóa vào file tạm chỉ chủ tiến trình được đọc, truyền đường dẫn/mật khẩu qua `IHOME_SIGNING_STORE` và `IHOME_SIGNING_PASSWORD`, rồi xóa file tạm khi kết thúc. `build/release-evidence/` chỉ chứa checksum APK, kết quả xác minh chữ ký, chứng chỉ công khai và thông tin phiên bản công cụ/commit. Chứng chỉ APK phải trùng chứng chỉ trong kho khóa; không đưa kho khóa riêng hay mật khẩu vào artifact, cache hoặc mã nguồn.

Bản dùng thật được đăng lên GitHub Release gắn thẻ `v<versionName>` (ví dụ `v2.0.0`), file `app-release.apk`. Cả nút tải ở trang Biến động số dư lẫn trang Điểm danh trên CRM đều phải trỏ tới bản này.

Giữ bản sao an toàn của khóa ký và dùng lại cho mọi bản cập nhật; tăng `versionCode` khi phát hành bản tiếp theo (2.0.0 là `versionCode 3`). APK release không cài đè lên APK debug có chữ ký khác; bản thử có hậu tố `.thu` nên là app riêng. Gỡ app sẽ xóa cấu hình, ghép nối điểm danh và tin còn trong hàng đợi của cả hai phần, nên gửi hết trước khi gỡ.
