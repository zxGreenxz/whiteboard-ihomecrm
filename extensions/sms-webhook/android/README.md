# iHome Gateway cho Android

App Android 8 trở lên chuyển toàn bộ SMS mới và thông báo mới/cập nhật của các app đã chọn đến nguồn nhận trong iHome CRM. App không đọc hộp thư cũ, đăng nhập ngân hàng, tự ghi sổ hoặc gửi email.

## Kết nối

1. Trên CRM mở **Biến động số dư → Nguồn kết nối → Thêm nguồn**. Lấy URL HTTPS và mã kết nối riêng cho nguồn.
2. Cài APK, mở **iHome Gateway**, nhập URL và mã kết nối.
3. Chọn SMS và/hoặc các app ngân hàng. Cấp quyền nhận SMS hoặc Truy cập thông báo tương ứng.
4. Bấm **Bật chuyển tiếp**, rồi **Kiểm tra kết nối ngay**. Trạng thái chỉ xác nhận khi nhận được biên nhận hợp lệ của CRM.

SMS được chuyển toàn bộ, gồm cả OTP và tin cá nhân. Android/ngân hàng có thể ẩn nội dung thông báo; app không vượt qua cơ chế này. Giữ điện thoại có Internet, sóng SIM nếu dùng SMS và cho phép chạy nền theo cài đặt của hãng.

App gửi `gateway.heartbeat` khoảng mỗi 15 phút khi bật, cùng trạng thái quyền và phiên bản app. Android có thể trì hoãn công việc nền; không có SMS mới không đồng nghĩa điện thoại đã mất kết nối. Bấm Tạm dừng sẽ ngừng nhận/gửi tiếp; yêu cầu đang gửi có thể đã tới máy chủ.

## Dữ liệu và biên nhận

- Cấu hình/mã kết nối và nội dung chờ gửi được mã hóa bằng AES-GCM với khóa AndroidKeyStore; tắt backup và truyền thiết bị.
- Mỗi tin có ID ổn định, hàng đợi được lưu trước khi gửi. Mạng lỗi, HTTP 408/429/5xx được thử lại. Lỗi khác giữ dữ liệu để người dùng xử lý/thử lại/xóa.
- Chỉ chấp nhận biên nhận JSON `schemaVersion:1`, `ok:true`, có `data.externalId` trùng ID yêu cầu, `sourceId` UUID đúng nguồn đã ghép, loại trạng thái và `acceptedAt` hợp lệ. HTTP 2xx rỗng/HTML không được tính là đã gửi.
- Tin đã xác nhận được bỏ nội dung khỏi hàng đợi; giữ tối đa 100 trạng thái thành công gần nhất. Nội dung tối đa 8192 byte UTF-8; toàn bộ JSON tối đa 64 KiB.
- Hàng đợi gắn với cả URL và mã kết nối của nguồn. **Đổi/thu hồi mã khi hàng đợi đã gửi hết**, hoặc chủ động xóa tin chưa gửi. App không tự chuyển tin của nguồn cũ sang nguồn mới. Cấu hình mới xóa ghép `sourceId` cũ để xác nhận lại từ CRM.

## Build và kiểm chứng

Runtime được ghim trong Gradle: JDK 17, Gradle 8.11.1, Android SDK Platform 35 và Build Tools 35.0.0. Không đặt mã kết nối thật vào source hoặc CI.

Trên Windows đã có SDK được cấp phép:

```powershell
.\build.ps1 -JavaHome "<JDK17>" -AndroidSdk "<SDK>"
```

CI Linux có SDK sẵn dùng `bash extensions/sms-webhook/android/ci-build.sh`: chạy unit tests, Android lint, tạo APK và test APK. Script kiểm thành phần SDK tồn tại và tắt tải SDK tự động; không chấp nhận thỏa thuận thay người dùng. APK ở `app/build/outputs/apk/debug/app-debug.apk`, biên nhận/checksum ở `build/ci-evidence/`.

`ci-device.sh` yêu cầu emulator, image `system-images;android-35;google_apis;x86_64` đã cài và KVM. Chạy 5 instrumentation tests trên thiết bị dùng một lần để kiểm AndroidKeyStore/hàng đợi, heartbeat, đổi nguồn, biên nhận và giao diện; xuất `setup.png`, `status.png`. Thiếu emulator/image là kiểm chưa đạt, không tự coi là pass.

APK debug dùng để cài thử nội bộ. Cần giữ cùng khóa ký khi phân phối bản nâng cấp; không thay khóa của bản đang cài rồi ghi đè ứng dụng. Kiểm trên emulator không thay bằng chứng nhận SMS/thông báo ngân hàng thật hoặc độ ổn định chạy nền của từng hãng điện thoại.

## APK phát hành

`ci-release.sh` tạo `app/build/outputs/apk/release/app-release.apk` bằng khóa riêng, alias cố định `ihome-gateway`. Chỉ chạy bước ký trên nhánh `main` đã tin cậy; không cung cấp khóa cho pull request. CI cần hai secret `IHOME_BANK_ANDROID_KEYSTORE_B64` và `IHOME_BANK_ANDROID_PASSWORD` (cùng mật khẩu cho kho và khóa). Thiếu secret hoặc thiếu JDK 17/SDK 35 thì dừng, không sinh APK chưa ký thay thế.

Script giải mã kho khóa vào file tạm chỉ chủ tiến trình được đọc, truyền đường dẫn/mật khẩu qua `IHOME_SIGNING_STORE` và `IHOME_SIGNING_PASSWORD`, rồi xóa file tạm khi kết thúc. `build/release-evidence/` chỉ chứa checksum APK, kết quả xác minh chữ ký, chứng chỉ công khai và thông tin phiên bản công cụ/commit. Chứng chỉ APK phải trùng chứng chỉ trong kho khóa; không đưa kho khóa riêng hay mật khẩu vào artifact, cache hoặc mã nguồn.

Giữ bản sao an toàn của khóa ký và dùng lại cho mọi bản cập nhật; tăng `versionCode` khi phát hành bản tiếp theo. APK release không cài đè lên APK debug có chữ ký khác: cần gỡ bản thử trước rồi thiết lập lại app. Gỡ app sẽ xóa cấu hình và tin còn trong hàng đợi, nên gửi hết trước khi đổi bản.
