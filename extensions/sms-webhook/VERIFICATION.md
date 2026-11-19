# Kiểm chứng iHome Gateway

## Kết quả đã xác nhận

| Phần | Kết quả |
| --- | --- |
| Java thuần, JDK 17/JUnit 4.13.2 | 12/12 đạt: URL/token, UTF-8, ID, retry, giới hạn JSON, gắn nguồn và biên nhận |
| SQL inbox, PGlite | 8/8 đạt |
| Hai Edge functions, Deno | 11/11 đạt |
| Giao diện CRM, E2E | 4/4 đạt |
| Cổng VPS tùy chọn, Node HTTP | 10/10 đạt |
| Script ký release | Cú pháp và 5 fixture luồng thành công/lỗi đạt; đã kiểm xóa khóa tạm và đối chiếu chứng chỉ |

Schema backend đã triển khai trên production và TEST. Hai Edge functions `bank-event-ingest` và `bank-event-admin` đã triển khai bản v3. Kiểm live trên TEST đạt toàn bộ, `cleanup: true`; đây là bằng chứng backend, chưa thay thế thử điện thoại thật.

Review độc lập phần Android, backend, quyền super admin và giao diện không còn finding P1/P2 mở trong phạm vi đã sửa và kiểm lại. Khóa ký phát hành ổn định đã được lưu trong kho bí mật chính và GitHub Secrets; khóa riêng/mật khẩu không nằm trong mã nguồn hoặc artifact.

## Bằng chứng cần lấy từ CI trước khi giao APK

- Từ bản 2.0.0 app gồm cả phần Điểm danh. Android build, lint, unit test và instrumentation test của cả hai phần chỉ có bằng chứng từ workflow **Android Gateway**; xem kết quả và artifact `ihome-bank-gateway-<sha>` của đúng commit. Các kiểm Java thuần ở bảng trên không chứng minh các lớp Android đã compile hoặc chạy được.
  - `build/ci-evidence/jvm-suites.txt`: hai bộ JUnit `GatewayPolicyTest` (12) và `CheckinPolicyTest` (57) chạy đủ, không bỏ qua. `apk-badging.txt`, `apk-permissions*.txt`, `apk-verified.txt`: kết quả `android/ci-verify-apk.sh` trên APK debug — gói, phiên bản, tên app, biểu tượng mở duy nhất và danh sách quyền. `apk-verify-refusals.txt`: cùng script từ chối APK debug khi được hỏi theo tên gói hoặc tên app của bản release (bằng chứng script không bỏ qua tham số, vì bước release chỉ chạy trên `main`).
  - `build/ci-evidence/android-35/`: 31 instrumentation test trên Android 15 (5 của Biến động số dư, 18 của Điểm danh, 8 của màn hình đầu). `build/ci-evidence/android-29/`: 26 test trên Android 10 (Điểm danh và màn hình đầu; bộ Biến động số dư chỉ chạy trên Android 15).
  - Mỗi thư mục còn có 4 bước trên bản cài sạch (`clean-install-*.txt`: màn hình đầu không xin quyền, không đặt báo thức hay việc nền; hàng đợi mã hóa qua một lần tắt hẳn tiến trình; các bước cấp quyền của máy chưa cấp gì), ảnh `diemdanh-*.png`, `gateway-setup.png`, `gateway-status.png` và `alarm-dump.txt`.
- APK release đã ký cùng checksum/chứng chỉ phải được tạo và xác minh thành công trong CI trên `main`; `ci-release.sh` chạy cùng `ci-verify-apk.sh` trên APK release (gói `vn.ihome.smsgateway`, tên «iHome Gateway») và ghi kết quả vào `build/release-evidence/`. Fixture ký chỉ kiểm luồng script bằng công cụ giả lập, chưa tạo APK Android thật.
- Giữ khóa ký ổn định cho các bản cập nhật; không cài đè APK release lên bản debug có chữ ký khác.

## Chưa kiểm trên thiết bị / chưa triển khai

- Chưa thử SIM thật, SMS nhiều phần/hai SIM, quyền hệ thống, thông báo app ngân hàng thật, Doze, reboot hoặc force-stop.
- Bản 2.0.0 (gộp Điểm danh): chưa cài đè lên Gateway 0.2.0 trên máy thật, chưa chạy phần Điểm danh của app gộp trên máy thật, chưa kiểm Play Protect xử lý file cài ra sao. Màn hình đầu của máy đang bật chuyển tiếp chỉ được kiểm trên emulator (`HomeDeviceTest`), với địa chỉ nhận không tồn tại.
- Chưa triển khai cổng VPS/nginx hoặc kiểm điện thoại → VPS. Đường nhận hiện tại dùng trực tiếp Supabase Edge.
- Phép kiểm mutation xác thực cũ trên bản sao tạm chưa chạy vì automatic approval review đã từ chối (`blocked by policy`); không tính phép kiểm này là đạt.
