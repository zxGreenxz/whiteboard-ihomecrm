# Worker đọc đồng hồ điện

Worker CPU kéo một tác vụ mỗi lần qua Edge `meter-capture-worker`. Không nhận khoá service-role, URL media từ người dùng hoặc kết nối trực tiếp database. Original phải được Edge đọc lại từ bucket riêng tư `meter-capture-media`, kiểm SHA-256 theo luồng và chữ ký định dạng trước khi đưa vào hàng đợi. Ảnh và video chỉ đủ điều kiện xác nhận sau khi worker giải mã thành công; video còn phải qua phép đo thời lượng bằng FFprobe.

## Cấu hình máy chạy

- Linux x86_64, CPU có AVX hiển thị trong `/proc/cpuinfo` (khuyến nghị AVX2), Docker Compose, 2 CPU, 4 GB RAM; tối đa 1 GB thư mục tạm. Không mở cổng nghe. Worker kiểm AVX trước khi nhận việc; VPS dùng CPU ảo kiểu KVM cũ có thể thiếu AVX dù đã tăng RAM. Cần nhà cung cấp cấp CPU phù hợp hoặc bật host CPU passthrough; không tự thay cấu hình máy chủ ảo hóa.
- VPS dùng chung với các dịch vụ hiện có: đề xuất 4 vCPU, 8 GB RAM và SSD 80 GB cho một worker thí điểm. Dành tối thiểu 4 GB RAM khả dụng trước khi khởi động worker và 15 GB đĩa trống cho image/build/log. Đây là cấu hình triển khai ban đầu, chưa phải cam kết thông lượng. Nếu chạy hai worker đồng thời, dùng 8 vCPU/16 GB RAM và đo lại hàng đợi, chi phí AI, RAM thực tế. Sol chạy qua 9router, không cần GPU tại VPS. Ảnh/clip gốc lưu ở Supabase riêng tư, không giữ lâu dài trên ổ VPS.
- Kho Supabase production Pro cần global `fileSizeLimit` tối thiểu 104857600 byte và bucket `meter-capture-media` cùng giới hạn 100 MiB. Tăng global limit không thay ACL hoặc công khai bucket. TEST Free vẫn thử được luồng bằng clip dưới 50 MiB; ca tải trên 50 MiB cần môi trường cho phép kích thước tương ứng. Giới hạn gói và bucket: https://supabase.com/docs/guides/storage/uploads/file-limits.
- `METER_CAPTURE_API_BASE_URL`: URL HTTPS đầy đủ của Edge function, kết thúc `/functions/v1/meter-capture-worker`.
- `METER_CAPTURE_WORKER_TOKEN`: secret riêng tối thiểu 32 ký tự, giống secret của Edge. Tuyệt đối không dùng service-role hoặc khai báo `VITE_*`.
- `METER_CAPTURE_AI_BASE_URL`, `METER_CAPTURE_AI_KEY`: cổng 9router/OpenAI-compatible HTTPS hiện có, cấu hình phía server; `METER_CAPTURE_AI_MODEL` mặc định `cx/gpt-6.1-terra`. Request cố định `reasoning_effort: medium`, ảnh `detail: original`. Đo ngày 28/10/2026 trên cùng bộ khung thật (7 ảnh/clip, 4 đồng hồ, mỗi cấu hình 2 lần): Sol medium, Terra medium và Terra high cùng 12/14 lượt nhận số, không lượt nào sai số; Terra nhanh hơn khoảng 1,5–2 lần, mức high không cải thiện. Mẫu nhỏ, chưa phải tỷ lệ chính xác. Cấu hình đồng hồ độc lập với Báo chi nhanh. Thiếu AI thì tác vụ giữ kết quả server và báo bộ AI lỗi.
- Edge cần `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `METER_CAPTURE_WORKER_TOKEN`. User RPC luôn dùng JWT người dùng. Chỉ các thao tác claim/receipt/complete và truy cập object đã kiểm scope mới dùng service-role bên Edge.
- Danh sách lượt chụp trả tham chiếu `/object/authenticated/` không chứa token; giao diện ký bằng JWT khi mở chứng cứ. Đây là object riêng tư, không phải URL công khai. Đường xem chứng cứ đơn lẻ ký tối đa hai URL trong 5 phút, kiểm scope bằng JWT người xem.

Sau migration/Edge đã phát hành đúng lane của Project Contract và đã nghiệm thu môi trường thử: `docker compose build`, rồi `docker compose up -d`. Container tự khởi động lại sau lỗi hoặc khi máy khởi động; dừng chủ động bằng `docker compose stop` thì giữ trạng thái dừng. Log được xoay vòng tối đa ba tệp 10 MB. Ảnh đã tải và chỉ số vẫn ở hệ thống. Việc chạy thật cần cấu hình secret từ vault, không lưu `.env` vào Git.

Khi phát hành web/database trước lúc nâng VPS, giữ `METER_CAPTURE_WORKER_TOKEN` chưa cấu hình trên production Edge. Gateway sẽ chặn tải danh mục thu thập, đăng ký QR và tạo lượt mới; web báo chưa bật bộ đọc và tiếp tục dùng ghi chỉ số hiện tại. Điều này tránh kích hoạt hồ sơ QR (vốn khóa cách duyệt cũ) khi chưa có máy giải mã chứng cứ. Chỉ cấu hình bearer production sau khi máy đủ tài nguyên, image đã kiểm và worker sẵn sàng khởi động. Bearer có mặt là điều kiện bật thu thập, không phải phép kiểm worker đang khỏe; phải kiểm worker/queue thực tế trước khi hướng dẫn quản lý dùng.

Image Python ghim digest Docker Hub; Debian dùng snapshot cố định; 63 wheel Python trong `requirements.lock` ghim phiên bản và SHA-256 cho CPython 3.12/Linux x86_64. Hai model từ tài khoản PaddlePaddle chính thức trên HuggingFace ghim revision, trọng số kiểm SHA-256. Model tải lúc build, không đổi âm thầm khi chạy.

## Hành vi nhận dạng

- Chặn tệp trên 100 MiB, clip trên 60 giây, nhiều video stream và ảnh trên 20 triệu pixel. FFmpeg chỉ được đọc giao thức file, không đọc URL mạng từ container media; không dùng shell.
- Trích 5 fps, chia các khoảng thời gian và chọn ảnh rõ bằng OpenCV (tối đa 16 ảnh mỗi lượt). PaddleOCR dò vùng chữ, giữ đơn vị/thanh ghi; bộ server không suy đoán dấu thập phân, không lấy số serial/V/A, không ghép các chữ số mờ. Mảnh số đứng cạnh token có chữ số khác, kể cả token yếu, không được xem là toàn bộ chỉ số; thanh ghi phải ở gần vùng số. Hai ứng viên giống nhau trên hai vùng khác nhau vẫn phải từ chối.
- Hai bộ đọc nhận cùng tập ảnh ban đầu, chạy song song và không xem kết quả của nhau. Bộ đọc chưa đủ hai khung ổn định được thử thêm các ảnh chọn từ 10 fps nếu còn ngân sách thời gian; bộ đã ổn định giữ kết quả và không gọi lại. OCR không đọc lại bytes cũ tại timestamp trùng hai lượt. Lượt sau bổ sung quan sát, không xoá giá trị bất đồng ở lượt đầu. Lỗi dịch vụ không tự gọi lại.
- AI không nhận số OCR, số kỳ trước hoặc thông tin khách thuê. Chỉ nhận schema JSON chặt, đủ một kết quả cho từng frame, vị trí frame hợp lệ và đơn vị/thanh ghi trùng cấu hình. Mỗi frame phải tự đủ chữ số và dấu thập phân/thang đo nhìn rõ; không mượn chữ số từ frame khác. AI thấy nhiều đồng hồ thì không được đề xuất chỉ số.
- Video cần ít nhất hai timestamp cách nhau tối thiểu 0,15 giây cùng toàn bộ chỉ số. Hai số khác nhau dù chênh một chữ số đều cần đối chiếu. Giữ tối đa ba JPEG cùng timestamp cho mỗi bộ đọc, phủ từ thời điểm đầu đến cuối; tổng tối đa sáu ảnh khi hai bộ rõ ở các thời điểm khác nhau. Không cắt mất chứng cứ của bộ đọc sau chỉ vì ba ảnh đầu thuộc bộ đọc trước; original không bị sửa.
- Định danh cố ý thận trọng: QR khác/QR thứ hai, AI nhận thấy nhiều đồng hồ hoặc QR không hiện trong khung chứng cứ đều yêu cầu kiểm tra thủ công. Clip có QR đầu đoạn rồi zoom sát ra ngoài QR vẫn được phân tích nhưng không được coi là đã xác minh định danh tự động.
- Mỗi tác vụ có lease; quá 300 giây dừng tiến trình xử lý. Ngân sách mềm 240 giây giúp giữ kết quả AI đã có khi CPU chậm: không bắt đầu thêm khung OCR nếu còn dưới 20 giây, không bắt đầu lượt 10 fps nếu không đủ dự trù trích ảnh và đọc tiếp. Timeout AI tối đa 90 giây, giảm theo thời gian còn lại; shutdown không đợi thêm request bị treo. Hết ngân sách phải xem lại, không coi bộ đọc còn thiếu là đã đồng ý. Một lần giải mã/nhận dạng đang chạy vẫn do giới hạn cứng bảo vệ. Lỗi không ghi nội dung ảnh, thông tin khách hoặc secret vào log. Worker không chốt chỉ số, hoá đơn hay thanh lý.
- Yêu cầu HTTPS gửi nhận dạng `User-Agent: ihome-meter-capture/1` cùng bearer. Cổng AI hiện tại từ chối nhận dạng mặc định của Python; khóa, HTTPS và cơ chế chặn chuyển hướng vẫn được kiểm như cũ.

## Kiểm thử và phần chưa xác minh

Chạy unit/pipeline fixture không cài mô hình, không gọi API trả phí:

```text
cd infra/meter-capture-worker
python -B -m unittest -v test_domain.py test_pipeline.py
```

Kiểm Edge từ thư mục repo:

```text
npx --yes deno@2.9.4 test --config supabase/functions/meter-capture-worker/deno.json supabase/functions/meter-capture-worker/index.test.ts --allow-env
```

Fixture kiểm chữ số/thanh ghi/thập phân, mảnh OCR thiếu chữ số, hai vùng cùng số, số nháy khác nhau, khung trùng timestamp, lỗi AI, cấu hình Sol/medium/original, chọn ảnh độc lập, retry 10 fps không xoá bất đồng và giữ đủ chứng cứ ở hai tập timestamp rời nhau. Edge kiểm cách ly user/worker, lease, không đọc object ngoài tác vụ, SHA/magic, giới hạn stream và ký ảnh bằng JWT người dùng. Đây không phải kết quả đo độ chính xác OCR ngoài thực tế.

Workflow `.github/workflows/meter-capture-runtime.yml` chạy trên Linux, build image đã ghim rồi thực thi `runtime_smoke.py` trong container không mạng/không secret: dùng PaddleOCR thật đọc JPEG và clip H.264 tổng hợp, kiểm bỏ qua màn V và giữ hai timestamp kWh. Có thể chạy cùng phép kiểm bằng `node --test infra/meter-capture-worker/runtime.test.mjs` trên máy Linux có Docker. Phép kiểm này không thay thế ảnh/clip đồng hồ thật.

Kết quả và ảnh đối chiếu của chỉ số đã chốt được cố định tại thời điểm xác nhận; các lượt đọc bổ sung vẫn giữ trong lịch sử và có cảnh báo, không thay ảnh/giá trị đã duyệt. Chỉ số đã gắn chứng cứ không cho ghi đè trực tiếp.

CI Linux đã build image và chạy PaddleOCR/FFmpeg thật trên ảnh JPEG/clip H.264 tổng hợp. Cổng AI thật đã đọc đúng mẫu tổng hợp `12345.67` và mẫu `00078.26` có số 0 đầu; chọn đúng hai thời điểm kWh 1.8.0, bỏ màn V và thanh ghi kWh 2.8.0. Đây là kiểm tích hợp bằng fixture, chưa phải đo độ chính xác đồng hồ thật.

So sánh ảnh đồng hồ thật được lưu riêng trong báo cáo nội bộ, không đưa ảnh, số điện hay nội dung khách vào repository. Kết quả chọn Sol không chứng minh OCR đạt độ chính xác sản xuất: parser có thể từ chối ảnh mà người đọc được và chưa chứng minh phát hiện được mọi chữ số bị OCR bỏ sót. Kết quả lệch, thiếu một bộ đọc hoặc thiếu chứng cứ đều phải được quản lý xem lại trước khi chốt.

Docker Linux engine tại máy phát triển Windows chưa hoạt động. Kiểm codec Android/iPhone, throughput/chi phí và migration/storage production vẫn cần nghiệm thu riêng. Máy triển khai phải có đủ tài nguyên cho giới hạn 4 GB của container và phần dịch vụ khác đang chạy. Không mở rộng vận hành trước khi kiểm các mục này trên toà thí điểm.
