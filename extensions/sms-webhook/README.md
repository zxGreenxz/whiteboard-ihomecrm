# iHome Gateway — SMS và thông báo ngân hàng về CRM

App Android riêng chuyển SMS và thông báo ngân hàng vào trang tổng **Biến động số dư** của CRM. Chỉ super admin xem và quản lý nguồn. Chưa tự nhận diện thanh toán, ghi sổ hoặc đọc email.

## Phạm vi

- Chuyển **mọi SMS mới nhận**, kể cả OTP và SMS cá nhân, theo lựa chọn của chủ điện thoại. Không đọc lại hộp thư cũ.
- Đọc thông báo mới/cập nhật từ **các app ngân hàng do người dùng chọn**. Gửi phần nội dung Android cung cấp; máy chủ chịu trách nhiệm phân loại giao dịch/quảng cáo.
- Có thể bật SMS, thông báo, hoặc cả hai. App mặc định tạm dừng; quyền nhận SMS và truy cập thông báo do người dùng cấp trên điện thoại.
- Hàng chờ SQLite trên điện thoại giữ tin khi mất mạng. Nội dung và cấu hình chứa token được mã hóa bằng Android Keystore; sao lưu tự động bị tắt.
- Gửi HTTPS, mã xác thực Bearer, ID chống ghi trùng. Không đi theo redirect. Lỗi mạng/408/429/5xx được thử lại; lỗi khác hiện trên app để người dùng xử lý.
- Có nút gửi dữ liệu giả lập, thử lại tin lỗi, tạm dừng và xóa hàng chờ. Nhật ký trạng thái không hiển thị nội dung SMS/token. Chỉ giữ 100 trạng thái gửi thành công gần nhất.
- Hàng chờ gắn với cả URL và khóa kết nối. Đổi một trong hai không tự chuyển tin cũ sang nguồn mới. Cấp lại khóa khi hàng chờ đã gửi xong; nếu khóa cũ đã mất hiệu lực, app cho biết tin bị giữ để chủ điện thoại quyết định.

## Cấu trúc

| Thư mục | Nội dung |
| --- | --- |
| `android/` | App Java, Android 8.0/API26 trở lên; target/compile API35 |
| `receiver/` | Mẫu receiver độc lập ban đầu, chỉ để tham khảo; không dùng cho app CRM 0.2.0 |
| `../../supabase/functions/bank-event-ingest/` | Webhook CRM, xác thực mỗi điện thoại và chỉ xác nhận sau khi lưu database |
| `../../infra/bank-event-gateway/` | Cổng trung gian VPS tùy chọn; chuyển tiếp HTTPS, không lưu nội dung tại VPS |

Xem [hướng dẫn trang CRM](../../docs/he-thong/25-bien-dong-so-du.md) và [hướng dẫn Android](android/README.md). Nội dung gốc được mã hóa AES-GCM tại backend; danh sách chỉ trả metadata, xem chi tiết cần quyền super admin và được ghi dấu vết.

## Build APK

Cần **JDK17**, **Android SDK Platform35**, **Build Tools35.0.0**. Gradle8.11.1 và AGP8.9.2 được ghim trong project; wrapper kiểm checksum bản Gradle tải về.

Người dùng cần tự đọc/chấp nhận [điều khoản Android SDK và tải công cụ chính thức](https://developer.android.com/studio#command-tools). Không có script tự chấp nhận license. Có thể mở thư mục `android/` bằng Android Studio và cài SDK tương ứng trong SDK Manager.

Trên Windows PowerShell, sau khi có SDK/JDK:

```powershell
cd "duong-dan-project\extensions\sms-webhook\android"
.\build.ps1 -JavaHome "C:\duong-dan\jdk-17" -AndroidSdk "C:\duong-dan\Android\Sdk"
```

Script chạy build APK debug, unit tests và Android lint. File cài thử nằm tại:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

APK debug dùng để cài thử. Khóa ký phát hành ổn định đã được lưu riêng; CI trên `main` dùng `android/ci-release.sh` để tạo và xác minh APK release. Lấy APK cùng bằng chứng chữ ký từ artifact của đúng commit sau khi bước phát hành đạt. Bản dùng thật được đăng lên GitHub Release (`v<versionName>`, file `app-release.apk`, SHA-256 trùng `apk-sha256.txt` của artifact); nút **Tải app Android** trên trang Biến động số dư trỏ tới bản đó qua hằng `gatewayApk` trong `src/pages/bank-events/BankEventsPage.tsx`, nên đăng bản mới phải đổi hằng này. Chưa phân phối qua Google Play. Không đưa token, khóa ký riêng hoặc mật khẩu vào mã nguồn, APK hay kho Git.

Có thể kiểm riêng logic Java không cần SDK:

```powershell
.\test-policy.ps1 -JavaHome "C:\duong-dan\jdk-17"
```

Kiểm logic Java **không thay thế** compile Android, kiểm quyền hệ thống, giao diện, hoặc thử nhận SMS/thông báo thật.

## Cài và kết nối điện thoại

1. Trong CRM, mở **Biến động số dư → Nguồn kết nối → Thêm nguồn**. Tạo nguồn riêng cho điện thoại và sao chép địa chỉ webhook cùng khóa chỉ hiện một lần.
2. Bấm **Tải app Android** ở đầu trang Biến động số dư (hoặc dùng APK đã build), cài trên điện thoại Android của bạn; mở **iHome Gateway**.
3. Dán URL đầy đủ và khóa do CRM vừa cấp vào app. Không dùng khóa dịch vụ Supabase hoặc mật khẩu tài khoản CRM.
4. Bật nguồn SMS nếu cần. Khi bật chuyển tiếp, chấp nhận quyền nhận SMS.
5. Bật nguồn thông báo nếu cần; chọn chính xác app ngân hàng và mở **Cấp quyền truy cập thông báo** để cấp quyền cho iHome Gateway trong Android Settings.
6. Bấm **Bật chuyển tiếp**, kiểm tra kết nối và gửi tin thử. Kiểm tra trạng thái điện thoại trong CRM rồi mở nội dung tin thử.
7. Thử một SMS không nhạy cảm và một thông báo ngân hàng thực tế. Thử tắt mạng rồi bật lại để xác nhận gửi bù/chống trùng.

Trên một số máy, Android có thể hạn chế cấp quyền nhạy cảm cho ứng dụng cài ngoài; việc cấp quyền phải do chủ điện thoại thực hiện trong cài đặt hệ thống. Không dùng Accessibility hoặc cách vượt bảo vệ Android.

## Giới hạn cần biết

- Đây là chuyển tiếp nội dung, không phải kết nối API ngân hàng. App không đăng nhập ngân hàng, đọc lịch sử giao dịch trong app, xác nhận thanh toán hay tự ghi sổ kế toán.
- Ngân hàng cần có thông báo Android và hiển thị nội dung. Thông báo bị ẩn, thông báo tùy biến không cung cấp text, hoặc nội dung bị hệ điều hành che có thể không đọc được. Android15 có cơ chế che OTP trong NotificationListenerService.
- Một giao dịch có thể tạo cả SMS và thông báo hoặc nhiều lần cập nhật thông báo. ID webhook chỉ chống gửi lại **cùng sự kiện**; máy chủ vẫn cần đối chiếu để không tính tiền hai lần từ các nguồn khác nhau.
- Không cam kết thời gian thực tuyệt đối. Android có thể trì hoãn công việc khi Doze/tiết kiệm pin; buộc dừng app sẽ ngừng nhận đến khi mở lại. Hàng chờ có công việc khôi phục định kỳ 15 phút, lịch thực tế do Android quyết định.
- Sau khởi động lại, mở khóa điện thoại trước khi dùng; chưa xử lý nhận dữ liệu trước lần mở khóa đầu tiên. Không đọc bù hộp thư SMS cũ.
- Giới hạn mỗi nội dung là 8192 byte UTF-8; nội dung vượt mức bị báo lỗi, không cắt ngầm. Hết bộ nhớ hoặc lỗi Keystore cần xử lý tại điện thoại; không thể bảo đảm giữ tin nếu thiết bị không ghi được dữ liệu.
- Tạm dừng/xóa hàng chờ không thu hồi HTTP request đã gửi ra hoặc dữ liệu đã tới VPS.
- Mẫu receiver SQLite cũ không phải đường triển khai CRM. App 0.2.0 yêu cầu biên nhận mới từ backend CRM; không ghép app mới với mẫu cũ.

## Tình trạng kiểm chứng

Xem [VERIFICATION.md](VERIFICATION.md) để phân biệt kiểm đã chạy với phần còn thiếu. Chưa coi source là bản đã nghiệm thu trên điện thoại.

## Tài liệu API chính thức

- [Android NotificationListenerService](https://developer.android.com/reference/android/service/notification/NotificationListenerService)
- [Android15: bảo vệ nội dung nhạy cảm trong thông báo](https://developer.android.com/about/versions/15/behavior-changes-all#otp-redaction)
- [WorkManager và công việc bền vững](https://developer.android.com/develop/background-work/background-tasks/persistent)
