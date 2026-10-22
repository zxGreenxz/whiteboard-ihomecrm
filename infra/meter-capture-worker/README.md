# Worker đọc đồng hồ điện

Worker CPU kéo một tác vụ mỗi lần qua Edge `meter-capture-worker`. Không nhận khoá service-role, URL media từ người dùng hoặc kết nối trực tiếp database. Original phải được Edge đọc lại từ bucket riêng tư `meter-capture-media`, kiểm SHA-256 theo luồng và chữ ký định dạng trước khi đưa vào hàng đợi. Ảnh và video chỉ đủ điều kiện xác nhận sau khi worker giải mã thành công; video còn phải qua phép đo thời lượng bằng FFprobe.

## Cấu hình máy chạy

- Linux x86_64, Docker Compose, 2 CPU, 4 GB RAM; tối đa 1 GB thư mục tạm. Không mở cổng nghe.
- `METER_CAPTURE_API_BASE_URL`: URL HTTPS đầy đủ của Edge function, kết thúc `/functions/v1/meter-capture-worker`.
- `METER_CAPTURE_WORKER_TOKEN`: secret riêng tối thiểu 32 ký tự, giống secret của Edge. Tuyệt đối không dùng service-role hoặc khai báo `VITE_*`.
- `METER_CAPTURE_AI_BASE_URL`, `METER_CAPTURE_AI_KEY`: cổng 9router/OpenAI-compatible HTTPS hiện có, cấu hình phía server; `METER_CAPTURE_AI_MODEL` mặc định `cx/gpt-5.6-terra(low)`, cùng ứng viên đọc của Báo chi nhanh. Thiếu AI thì tác vụ giữ kết quả server và báo bộ AI lỗi.
- Edge cần `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `METER_CAPTURE_WORKER_TOKEN`. User RPC luôn dùng JWT người dùng. Chỉ các thao tác claim/receipt/complete và truy cập object đã kiểm scope mới dùng service-role bên Edge.
- Danh sách lượt chụp trả tham chiếu `/object/authenticated/` không chứa token; giao diện ký bằng JWT khi mở chứng cứ. Đây là object riêng tư, không phải URL công khai. Đường xem chứng cứ đơn lẻ ký tối đa hai URL trong 5 phút, kiểm scope bằng JWT người xem.

Sau migration/Edge đã phát hành đúng lane của Project Contract và đã nghiệm thu môi trường thử: `docker compose build`, rồi `docker compose up`. Không có tự khởi động lại hoặc script tự deploy. Dừng bằng `docker compose stop`; ảnh đã tải và chỉ số vẫn ở hệ thống. Việc chạy thật cần cấu hình secret từ vault, không lưu `.env` vào Git.

Image Python ghim digest Docker Hub; Debian dùng snapshot cố định; 63 wheel Python trong `requirements.lock` ghim phiên bản và SHA-256 cho CPython 3.12/Linux x86_64. Hai model từ tài khoản PaddlePaddle chính thức trên HuggingFace ghim revision, trọng số kiểm SHA-256. Model tải lúc build, không đổi âm thầm khi chạy.

## Hành vi nhận dạng

- Chặn tệp trên 100 MiB, clip trên 60 giây, nhiều video stream và ảnh trên 20 triệu pixel. FFmpeg chỉ được đọc giao thức file, không đọc URL mạng từ container media; không dùng shell.
- Trích 5 fps, chia các khoảng thời gian và chọn ảnh rõ bằng OpenCV (tối đa 16 ảnh). PaddleOCR dò vùng chữ, giữ đơn vị/thanh ghi; bộ server không suy đoán dấu thập phân, không lấy số serial/V/A, không ghép các chữ số mờ. Chưa có hai khung ổn định thì thử 10 fps.
- AI nhận đúng các ảnh đại diện cuối cùng mà server đọc; không nhận số OCR, số kỳ trước hoặc thông tin khách thuê. Chỉ nhận schema JSON chặt, vị trí frame hợp lệ và đơn vị/thanh ghi trùng cấu hình.
- Video cần ít nhất hai timestamp khác nhau cùng toàn bộ chỉ số. Hai số khác nhau dù chênh một chữ số đều cần đối chiếu. Giữ tối đa ba JPEG chứng cứ và timestamp; original không bị sửa.
- Định danh cố ý thận trọng: QR khác/QR thứ hai, AI nhận thấy nhiều đồng hồ hoặc QR không hiện trong khung chứng cứ đều yêu cầu kiểm tra thủ công. Clip có QR đầu đoạn rồi zoom sát ra ngoài QR vẫn được phân tích nhưng không được coi là đã xác minh định danh tự động.
- Mỗi tác vụ có lease; quá 300 giây dừng tiến trình xử lý. Lỗi không ghi nội dung ảnh, thông tin khách hoặc secret vào log. Worker không chốt chỉ số, hoá đơn hay thanh lý.

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

Fixture kiểm chữ số/thanh ghi/thập phân, số nháy khác nhau, khung trùng timestamp, lỗi AI, chọn ảnh độc lập, retry 10 fps và định danh không chắc chắn. Edge kiểm cách ly user/worker, lease, không đọc object ngoài tác vụ, SHA/magic, giới hạn stream và ký ảnh bằng JWT người dùng. Đây không phải kết quả đo độ chính xác OCR ngoài thực tế.

Workflow `.github/workflows/meter-capture-runtime.yml` chạy trên Linux, build image đã ghim rồi thực thi `runtime_smoke.py` trong container không mạng/không secret: dùng PaddleOCR thật đọc JPEG và clip H.264 tổng hợp, kiểm bỏ qua màn V và giữ hai timestamp kWh. Có thể chạy cùng phép kiểm bằng `node --test infra/meter-capture-worker/runtime.test.mjs` trên máy Linux có Docker. Phép kiểm này không thay thế ảnh/clip đồng hồ thật.

Kết quả và ảnh đối chiếu của chỉ số đã chốt được cố định tại thời điểm xác nhận; các lượt đọc bổ sung vẫn giữ trong lịch sử và có cảnh báo, không thay ảnh/giá trị đã duyệt. Chỉ số đã gắn chứng cứ không cho ghi đè trực tiếp.

Chưa chạy build Docker hoặc inference Paddle trong môi trường phát triển này vì Docker Linux engine chưa hoạt động. Chưa gọi cổng AI thật, chưa đo bộ 300–500 ảnh/clip thật, chưa kiểm codec Android/iPhone, throughput/chi phí hay migration/storage production. Không mở rộng vận hành trước khi kiểm các mục này trên toà thí điểm.
