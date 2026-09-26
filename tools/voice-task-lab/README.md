# Trang thử tạo việc bằng giọng nói

Trang riêng, ưu tiên điện thoại. Tạo **bản nháp công việc thử nghiệm**, không ghi CRM. Ghi âm/nghe lại → chuyển âm thanh qua 9Router → AI tạo bản nháp → con người chấm từng trường và mức hữu ích.

## Trang trong webapp

Route `/voice-task-lab` dùng đăng nhập và quyền xem Công việc của app; mở từ ô **Thử giọng nói** hoặc menu Công việc. API `api/voice-task-lab.js` chỉ gọi 9Router sau khi xác thực người dùng, công ty đang chọn và quyền tương ứng. Env server Vercel dùng `VOICE_LAB_NINEROUTER_API_KEY`; không đặt khóa vào `VITE_*`.

Bản tích hợp app lưu đánh giá trên trình duyệt theo tài khoản/công ty, tối đa 100 lượt, có xuất JSON để gửi lại người phân tích. Không lưu vào CRM hoặc tự đồng bộ đa thiết bị. Upload qua API Vercel giới hạn 2 MiB; ghi âm/nghe lại vẫn dùng giới hạn thời gian của recorder. API nhận dạng không tự thay provider khi thiếu model STT.

## Chạy bản lab độc lập trên máy

Tại worktree, cài dependency bằng `npm ci`, dùng Node 24.18.0 theo runtime CI, rồi:

```powershell
npm run voice-lab:build
powershell -File tools/voice-task-lab/Start-Mobile-Lab.ps1
```

Launcher in đường dẫn HTTPS và mã truy cập. Mở link bằng Safari/Chrome trên điện thoại, nhập mã và cấp quyền micro. Máy tính phải hoạt động, server/tunnel còn chạy. Tunnel tạm, không phải deployment production. Nếu chỉ thử phần micro, thêm `-CaptureOnly`; chế độ này không đọc vault và không gọi upstream.

Mỗi launcher tạo hai tiến trình riêng và in PID. Dừng đúng hai PID đó khi kết thúc; không dừng tiến trình không thuộc phiên thử. Launcher không ghi mã truy cập hay key vào file.

Trước khi bật AI, xác nhận đúng máy chủ 9Router và khóa đang hoạt động với người vận hành. Thêm dòng `VOICE_LAB_NINEROUTER_API_KEY=<khóa đã xác nhận>` trong vault gốc `CLAUDE.local.md` (thay phần giữ chỗ bằng khóa thực), hoặc nạp process env `NINEROUTER_API_KEY`. Không tạo vault thứ hai. Loader không tự chọn khóa từ các mục VPS lịch sử. Endpoint được giới hạn ở `https://ai.chillhome.io.vn/v1`; nếu hệ thống thực tế dùng endpoint khác thì cần xác minh và sửa allowlist trước. Khi 9Router trả 401, kiểm tra đúng cặp endpoint/credential; không thử khóa khác để né lỗi.

## Đánh giá

- Bản dự đoán AI bất biến; phần sửa được giữ riêng.
- Độ đúng từng trường = số trường chấm Đúng / số trường chấm Đúng hoặc Sai.
- Đúng toàn bộ = số bản chấm đủ và mọi trường áp dụng đúng / số bản chấm đủ, có ít nhất một trường áp dụng.
- Hữu ích = số bản được người dùng chấm 4–5 / số bản có điểm 1–5.
- Không áp dụng/chưa chấm không được tính đúng. Không có mẫu thì chưa có phần trăm.
- Báo cáo nhóm theo nguồn transcript và model; nhập tay/nhận dạng trình duyệt không được gọi là STT 9Router. Sửa lời nhận dạng chuyển nguồn sang nhập tay, chỉ đo bước trích xuất. Các test mock chỉ kiểm chức năng phần mềm, không đo chất lượng AI.
- Nên thử 20–30 câu thực tế, gồm mã tòa/phòng, người trùng tên, ngày giờ tương đối, tiếng ồn và câu thiếu thông tin. Số mẫu nhỏ không đại diện cho hiệu quả thực tế.

Bấm Lưu đánh giá mới ghi transcript, predicted, expected, verdicts và điểm. Audio chỉ nằm trong bộ nhớ trình duyệt khi thao tác, không lưu trên đĩa. File đọc lại nằm ngoài Git:

`%LOCALAPPDATA%/iHomeCRM/voice-task-lab/results-20260926/evaluations.json`

Codex có thể đọc tệp này trong lần trao đổi sau để phân tích trường sai và đề xuất sửa. Nút tải JSON cho phép xuất cùng dữ liệu. Không có tác vụ theo dõi nền tự động.

## Kiểm tra kỹ thuật

```powershell
npm run voice-lab:test
npm run voice-lab:typecheck
npm run voice-lab:build
npx vitest run src/lib/voice-task-lab src/hooks/useVoiceTaskLabRecorder.test.tsx src/components/voice-task-lab/EvaluationPanel.test.tsx
# từ thư mục .e2e-fleet:
npx playwright test --config voice-task-lab.config.ts
```

E2E dùng provider tổng hợp và recorder giả lập trên hai engine; cần thêm bản ghi micro thật và provider thật trước khi đánh giá chất lượng. Backend chỉ nghe 127.0.0.1, yêu cầu cookie phiên/mã truy cập, kiểm Origin, giới hạn upload 10 MiB và hai request AI đồng thời. Đăng nhập giới hạn chung 5 lượt/phút cho phiên pilot một người; người khác biết link có thể làm bạn phải chờ một phút. Không dùng bản thử này làm dịch vụ nhiều người dùng.

Cloudflared 2026.9.3 được ghim SHA256 `f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2`; chỉ phục vụ thư mục build, không phục vụ source hoặc vault.
