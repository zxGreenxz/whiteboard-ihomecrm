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

- Android build, lint và 5 instrumentation tests đang chờ bằng chứng từ workflow **Android Gateway**; xem kết quả và artifact của đúng commit. Các kiểm Java thuần không chứng minh các lớp Android đã compile hoặc chạy được.
- APK release đã ký cùng checksum/chứng chỉ phải được tạo và xác minh thành công trong CI trên `main`. Fixture ký chỉ kiểm luồng script bằng công cụ giả lập, chưa tạo APK Android thật.
- Giữ khóa ký ổn định cho các bản cập nhật; không cài đè APK release lên bản debug có chữ ký khác.

## Chưa kiểm trên thiết bị / chưa triển khai

- Chưa thử SIM thật, SMS nhiều phần/hai SIM, quyền hệ thống, thông báo app ngân hàng thật, Doze, reboot hoặc force-stop.
- Chưa triển khai cổng VPS/nginx hoặc kiểm điện thoại → VPS. Đường nhận hiện tại dùng trực tiếp Supabase Edge.
- Phép kiểm mutation xác thực cũ trên bản sao tạm chưa chạy vì automatic approval review đã từ chối (`blocked by policy`); không tính phép kiểm này là đạt.
