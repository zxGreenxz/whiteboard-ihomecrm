# Trang thử giọng nói trên điện thoại

> Thiết kế lab độc lập ban đầu. Yêu cầu sau đã chuyển sang [trang trong webapp](2026-09-26-voice-task-webapp.md); trạng thái bên dưới là lịch sử trước tích hợp.

Yêu cầu tiếp nối: người dùng muốn tự ghi âm trên điện thoại, xem công việc tương ứng và chấm mức chính xác/hữu ích. Phạm vi lượt này là phòng thử độc lập; không ghi jobs vào CRM.

- Frontend React riêng, tái dùng shadcn/Lucide/Tailwind; build riêng không đổi route/bundle CRM.
- Node server localhost 4179; HTTPS tạm qua Cloudflare Tunnel ghim version và checksum. Đường dẫn chỉ sống khi máy/server/tunnel hoạt động.
- Mã truy cập riêng, cookie phiên HttpOnly, origin check, rate limit; 9Router key chỉ ở server và đọc từ vault duy nhất.
- Ghi âm tối đa60s/10MiB, nghe lại, STT9router, model9router trích xuất task; thay đổi transcript phải phân tích lại. Nếu thiếu STT, browser speech/nhập tay là lựa chọn tường minh, không tráo nguồn.
- Task thử có title,description,building,room,jobType,assignee,deadline,priority. Không tự tạo danh mục hoặc gán UUID CRM.
- predicted bất biến; expected là bản người dùng sửa. 7 trường title/building/room/jobType/assignee/deadline/priority có verdict chưa chấm/đúng/sai/không áp dụng.
- Chính xác trường = đúng/(đúng+sai), không áp dụng/chưa chấm không tính. Đúng toàn việc chỉ tính bản đã chấm đủ trường với ít nhất1 trường áp dụng. Hữu ích = số lượt chấm4–5 / số lượt có điểm1–5. Không có mẫu thì null, không tự đánh giá model.
- Kết quả tách theo nguồn transcript và model; lưu đánh giá khi người dùng bấm Lưu, không lưu audio, không ghi secret. Kho kết quả riêng ngoài Git để Codex đọc lại.

## Theo dõi

- [x] Backend, kiểm nguồn 9Router, schema và đánh giá.
- [x] Recorder/UI mobile, kết quả bất biến, đánh giá và xuất báo cáo.
- [x] Build riêng, runtime launcher, E2E mobile giả lập và review độc lập.
- [ ] Khởi chạy HTTPS cho điện thoại thật: lệnh mở server bị automatic approval review chặn; đã được thay bằng yêu cầu đưa trang vào webapp.
- [ ] Kết nối đúng 9Router đang hoạt động, chạy micro/provider thật và thu đánh giá.

## Bằng chứng ban đầu

- 9Router public health trả 200; models và models/stt trả 401 với khóa Hermes đã thử. Rà soát sau đó xác định đây là khóa máy chủ cũ, không thể gọi là credential hiện hành. Vault có bản ghi VPS Minh mới nhưng chưa xác nhận domain public đang trỏ vào origin nào; không thử khóa khác hoặc thay provider. Loader chỉ nhận khóa được chọn rõ cho Voice Lab hoặc process env.
- Chưa thể công bố tỷ lệ chính xác thực tế trước khi có audio, kết quả thật và nhãn do người dùng xác nhận.

## Kiểm chứng ngày 26/09/2026

- Node: 25/25 test; Vitest: 12/12 test, gồm lỗi chậm discovery và đổi Sai → Đúng.
- Playwright: 6/6 kịch bản trên Chromium Pixel 7 và WebKit iPhone 13, provider và micro tổng hợp. Kiểm lưu giữ nguyên dự đoán gốc, tách transcript sửa tay và chặn lưu dự đoán cũ.
- Strict typecheck của lab đạt; baseline toàn repo 0 fingerprint; build riêng đạt. JS gzip 91.95 kB, CSS gzip 27.77 kB.
- Gate test-matrix, agent-contract và docs check đạt. Hai suite server/mobile hiện chạy local, có hạn và điều kiện nối CI trong manifest.
- Chưa kiểm micro vật lý, chất lượng AI thật hoặc đường HTTPS công khai. Chưa commit/push/deploy CRM.

## Cập nhật cấu hình 9Router

- Người dùng đã cung cấp khóa mới và xác nhận dùng mật khẩu máy chủ mới. Đã xóa giá trị mật khẩu/API key 9Router Hermes/Seoul cũ khỏi vault duy nhất theo yêu cầu; không xóa máy chủ hay dịch vụ.
- Với khóa mới: `GET /v1/models` trả 200 với 20 model; `GET /v1/models/stt` trả 200 với danh sách rỗng. Đây là bằng chứng xác thực/catalog, chưa chứng minh model hoạt động.
- Một lượt trích xuất văn bản tổng hợp bằng `ag/gemini-3-flash` chưa thành công (provider adapter báo `PROVIDER_UNAVAILABLE`). Không lưu thành đánh giá thật, không tự đổi model/provider hoặc thử khóa khác.
- Đường tunnel bị automatic approval review từ chối; người dùng sau đó yêu cầu dùng route trong webapp. Không tiếp tục mở tunnel.
