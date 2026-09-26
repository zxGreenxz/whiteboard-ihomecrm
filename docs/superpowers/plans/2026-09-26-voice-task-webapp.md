# Trang thử giọng nói trong webapp

**Mục tiêu:** Người dùng mở trang thử trên webapp mobile đã đăng nhập, nói việc cần làm, xem bản nháp từ 9Router và chấm kết quả.

**Phạm vi đã được yêu cầu:** Thay đường thử qua tunnel bằng route `/voice-task-lab` trong app. Giữ bản lab độc lập để kiểm thử. Không tạo công việc thật, không đổi schema hay quyền nghiệp vụ.

**Thiết kế:** Route lazy dùng quyền `tasks.view`, có lối mở ở launcher/sidebar. API Vercel xác thực JWT qua GoTrue, kiểm công ty hiện tại và quyền bằng RPC có sẵn trước khi gọi 9Router. Khóa riêng của lab chỉ có ở server. Kết quả chấm lưu trong trình duyệt theo user/org, tối đa 100 lượt, tải JSON để gửi lại người phân tích. Không dùng settings/profile để chứa transcript vì các bảng đó có chính sách đọc rộng hơn một người dùng.

**Âm thanh:** Giữ nút ghi âm và nghe lại. Với đường Vercel, giới hạn bản ghi gửi lên 2 MiB; lỗi vượt trần có hướng dẫn ghi ngắn lại. 9Router hiện chưa cung cấp STT; người dùng chủ động chọn nhận dạng trình duyệt hoặc nhập chữ. Không đổi nhãn nguồn ngầm. Catalog model không được trình bày thành bằng chứng model đã chạy thành công.

## Công việc

- [x] API `api/voice-task-lab.js`, adapter auth/org/permission, validation và rate limit; kiểm lỗi 401/403/503, giới hạn âm thanh, chống truy cập sai org; mutation auth/org.
- [x] Wrapper app, route/capability/launcher/sidebar/breadcrumb; client Bearer/org; local evaluation store và clear/cancel khi đổi danh tính.
- [x] CI khai test server và browser; local server/Vitest/strict/baseline/build/bundle/docs đạt. E2E lab Chromium + WebKit 6/6; E2E app live còn chờ deployment.
- [ ] Review độc lập, stage đúng scope, gate trước push, draft PR vì có kiểm quyền; kiểm CI đúng SHA.
- [ ] Đưa secret được người dùng cung cấp vào env server Vercel; phát hành bằng lane promote của repo; đọc lại deployment SHA và thử trang đã deploy.

## Điều kiện thành công và giới hạn

- Trang mở trực tiếp từ webapp bằng quyền Công việc, không còn nhập mã lab riêng hay cần máy tính chạy tunnel.
- Người không đăng nhập, thiếu quyền hoặc chọn org không được phép không gọi được API AI.
- Ghi âm thật trên điện thoại và chất lượng AI chỉ được kết luận sau khi có lượt chạy thực tế. Browser/nhập tay không tính vào chỉ số STT 9Router.
- Lượt chấm giữ nguyên dự đoán gốc; không tự chấm đúng, không trộn nguồn, không tăng số mẫu khi lưu lại cùng ID.
- Dữ liệu đánh giá nằm trên thiết bị; Codex đọc lại khi người dùng gửi bản xuất JSON. Không có thu thập hay theo dõi nền.
- 9Router trả 503 ở hai lượt trích xuất tổng hợp đã thử. Tiếp tục triển khai trang và thông báo lỗi trung thực; không công bố tỷ lệ chất lượng từ các test mock.

## Bằng chứng trước phát hành

- Node server 37/37; Vitest liên quan 252/252; baseline 0; strict islands đạt.
- App build và bundle đạt; trang lazy 54.33 kB (gzip 17.20 kB). Docs check không có lỗi.
- Review độc lập API/phân quyền và frontend đã hoàn tất; đã sửa timeout discovery 10s để phù hợp giới hạn Vercel.
- Khóa lab mới đã cấu hình dạng sensitive trên Vercel preview/production, chỉ phía server. Khóa và mật khẩu cũ đã gỡ khỏi vault theo yêu cầu.
- Có spec live DEMO kiểm API401/cross-org403 và ghi/nghe lại trên Chromium mobile; cần chạy sau preview. Micro phần cứng điện thoại và AI thật chưa xác minh.

- Client JSON lỗi được phân loại rõ và giữ AbortError; 9/9 client regressions đạt, error-swallow ratchet không thêm nợ.
- Generated types/surface được làm tươi từ production theo gate; không thay schema. Pre-push local bỏ phép đo leak DB vì không sửa DB/RLS; API auth/org có mutation test và live spec riêng.
