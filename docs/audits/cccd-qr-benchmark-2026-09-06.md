# Kiểm thử QR và OCR CCCD — 06–07/09/2026

## Kết luận

Bản web trong worktree tính năng đã đọc **7/9 QR** từ ảnh người dùng gửi bằng worker ZXing/WeChat. Hai ảnh ghép hai mặt và thẻ xoay dọc chuyển sang OCR cục bộ, có bản xem trước đủ năm trường để sửa và áp dụng. Đây là số đo development trên ảnh đã dùng nghiên cứu, không phải tỷ lệ chính xác production hoặc cam kết đọc mọi ảnh.

Worker QR đã kiểm dưới CSP thật trên Chrome/Edge. Đối chứng thêm 54 ảnh Supabase khác tập phát triển: web đọc 12 payload, native đọc 11; không mất ca native đọc được, không có hai decoder trả khác payload, và parser chấp nhận cả 12. Tập có ảnh mặt sau/không có QR nên **12/54 không phải độ chính xác QR**. Hai số CCCD khác hồ sơ được cả hai decoder đọc giống nhau; không sửa database.

OCR production worker `CL1zkp2P` đã đối chiếu hai ảnh khó sau khi sửa kiểm tra tải nén, nhóm thông tin cùng thẻ và chữ bị cắt mép: cả năm giá trị khớp kết quả nghiên cứu trước, gồm đầy đủ địa chỉ (54 và 47 ký tự). Thời gian 6,898 và 6,787 giây, khởi tạo lần đầu 897 ms trên localhost; hai dictionary JSON được phục vụ bằng gzip với Content-Length của dữ liệu nén. Không có request ngoài origin hay lỗi console/page. Lượt trước `COPlepVy` mất 13,847 và 19,763 giây khi máy có tải đồng thời; không gán toàn bộ chênh lệch đó cho thuật toán.

Kết quả này giữ nguyên giới hạn của đối chiếu ảnh gốc: một địa chỉ khác vị trí dấu Hoà/Hòa; không tuyên bố mười trường đều đúng nguyên văn. Worker `DHr20uBw` qua bốn hướng xoay ảnh giả, offline sau tải, lỗi model 404 rồi thử lại. Ở `CL1zkp2P`, ảnh giả bị cắt thật tại dòng địa chỉ trả địa chỉ thiếu và bốn trường khác đúng; ảnh giả nguyên vẹn đọc đúng năm trường. Phép thử hai nhóm chữ thuộc hai thẻ khác nhau bị từ chối ở parser.

Kiểm tra Chrome headless có đăng nhập DEMO trên bản build `DHr20uBw`: cả `/customers/new` và popup khách hàng ở hợp đồng đều nhận Ctrl+V, hiện đủ năm trường OCR, giữ dữ liệu form cũ trước khi áp dụng, cho sửa địa chỉ rồi điền chính xác vào cả hai ô địa chỉ. Nơi cấp mặc định `Cục Cảnh sát`; ngày cấp cũ được xoá khi áp dụng bản xem trước đầy đủ. Không có lần ghi khách hàng/tải ảnh ngoài ý muốn, không lỗi console/page. Thời gian từ dán đến hoàn tất kiểm tra lần lượt 6,718 và 7,167 giây với ảnh giả trên localhost.

Camera trên bản build từ `f11cc6cc` đã được kiểm thêm qua giao diện thật có đăng nhập DEMO ở cả hai form: Chromium dùng thiết bị video giả 1400×850 chứa thẻ hoàn toàn giả, mở popup camera, bấm đọc chữ, chuyển ảnh toàn thẻ qua QR trước rồi OCR. Cả năm trường đúng; cho sửa địa chỉ và áp dụng đúng cả hai ô địa chỉ, nơi cấp mặc định và xoá ngày cấp cũ. Mọi media track được quan sát đều đã kết thúc khi OCR review hiện ra. Hai lượt mất 24,829 và 29,200 giây; 0 lần ghi khách hàng/tải ảnh, 0 lỗi console/page, CSP thật không bị bỏ qua. Đây là bằng chứng luồng giao diện với video giả, không phải webcam vật lý. Rà soát sau đó yêu cầu sửa cadence khi quét sâu chậm, phục hồi sau lỗi chụp và chọn khung nét; ba sửa đã qua rà soát lại ở `d1ece837`: cooldown tính sau khi quét sâu xong, lỗi chụp có thể khởi động lại camera, chọn khung nét trong tối đa ba mẫu cách nhau 70 ms và giải phóng bitmap khi huỷ. Trên build sửa này, camera QR trong cả hai form DEMO tự điền đúng trong 1,189 và 1,441 giây, popup đóng và mọi track đã kết thúc, không có OCR review/lần ghi khách hàng/tải ảnh/lỗi console/page.

Rà soát toàn nhánh và một lượt rà soát lại đã chấp thuận sáu sửa cuối: benchmark dùng đúng Vite module worker, huỷ ảnh chụp cũ khi thay phiên camera, mock component đúng quy tắc hook, thoát trạng thái nhiều QR khi khung tiếp theo thay đổi, xử lý Promise đóng âm báo và dọn tài nguyên benchmark khi thiết lập lỗi. Benchmark thật đọc đúng 6/6 ảnh giả ở nhánh hiện tại, so được với baseline lịch sử và trả sáu lỗi hữu hạn khi chặn worker. Các đột biến tương ứng đều bị test bắt và đã hoàn nguyên. Gate tích hợp yêu cầu ghi thêm lý do bỏ qua lỗi đóng âm báo ngay trong handler; chú thích được bổ sung, không đổi hành vi hay nới baseline.

Kiểm bản tích hợp: TypeScript ứng dụng, lint ratchet, build 4.779 module và bundle 511 chunk/219 kB entry đạt. Bộ Vitest đầy đủ đạt 417 file, 6.383 test trong 70,62 giây với tối đa hai worker; 446 test Node cũng đạt. Lượt Vitest dùng mức song song mặc định trước đó có một test lưu ảnh vượt 5 giây trong tổng 6.383 test; lần kiểm có giới hạn tài nguyên giữ nguyên timeout và toàn bộ assertions. Không coi lượt đầu là xanh. Các worker QR `Dq0Y5Okv` và OCR `CL1zkp2P`, fingerprint QR `4e2a89c885fd654f` và OCR `4c977d9f2626a098` không đổi so với các phép đo ảnh riêng đã ghi ở trên.

Gate tổng hợp cuối đạt 42/42 trong 104 giây, gồm đảo strict và các manifest sinh lại từ catalog chỉ đọc. Build sau chú thích âm báo đạt trong 13,30 giây. Camera QR trên bản này qua cả hai form DEMO trong 1,122 và 1,524 giây; không có lần ghi khách hàng/tải ảnh hay lỗi console/page. Đây vẫn là video giả và localhost.

Candidate `5b9a5e0d` đã lên main Preview: ứng dụng và tài liệu READY, CI quality đạt đủ 6.383 test cùng strict/bảo mật/types/cách ly tổ chức, nhưng gate múi giờ có một test thất bại ở mỗi múi giờ; script phát hành đã từ chối promote. Log gate không ghi tên test lỗi, nên không khẳng định đã xác định chính xác test đó. Test bảo toàn ảnh đạt ở quality CI trong 4.775 ms, gần ngưỡng 5 giây. Đo riêng phép so sánh mảng 1.600.803 byte bằng matcher mất 2,35–2,48 giây; so sánh toàn bộ byte bằng Buffer mất 0,26–0,40 ms. Test đã chuyển sang kiểm độ dài và Buffer.equals, giữ hai lần giải mã QR và timeout 5 giây; đột biến sửa byte cuối làm assertion thất bại. Bộ bốn test còn 108 ms. Lượt gate múi giờ đầu sau sửa vẫn có một lỗi UTC chưa định danh; chạy UTC trực tiếp đạt, lượt gate cuối đạt 5.057 test/317 file giống nhau ở cả bốn múi giờ. Cần CI mới của đúng candidate để quyết định phát hành, không dựa vào suy đoán nguyên nhân của lần lỗi trước.

**Trạng thái phát hành:** đã có Preview; production chưa được cập nhật tại lần ghi bằng chứng này. Rà soát và gate cục bộ đã hoàn tất, CI của đúng commit cuối và xác minh deployment là bước tiếp theo. Clipboard hệ điều hành Windows, webcam thật, Android Chrome và iPhone Safari chưa được kiểm vật lý. Tốc độ tải model lần đầu trên mạng công cộng và bộ nhớ thiết bị di động chưa có số đo. Các phần bên dưới giữ số đo lịch sử và phương pháp để đối chiếu.

Baseline ngày 06/09 tại `1d6523fb` bỏ sót nhiều ảnh: trên 57 ảnh của 30 khách hàng, code cũ đọc 4 chuỗi có dạng CCCD; ZXing-C++ WASM trực tiếp đọc 8; thêm xử lý thử nghiệm đọc 12; OpenCV WeChat native đọc 17. Không so tổng 57 ảnh này với tập 54 ảnh mới như cùng một phép đo.

Kế hoạch triển khai: [CCCD QR Reliability](../superpowers/plans/2026-09-06-cccd-qr-reliability.md).

## Phạm vi và quyền dữ liệu

- Người dùng yêu cầu dùng ảnh CCCD khách hàng đang có trong Supabase.
- Chỉ SELECT `id_images`, `id_number` của khách đang hoạt động trong org THẬT và đọc object ảnh qua phiên đăng nhập hợp lệ. Không sửa database, không upload ảnh mới, không tạo khách hàng.
- Chọn mẫu 30 khách theo `ORDER BY md5(id::text || 'cccd-qr-20260906')`; lấy mặt trước/mặt sau có sẵn, bỏ URL trùng, thu được 57 ảnh. Không chọn mẫu theo việc decoder nào đọc được.
- Ảnh, đường dẫn riêng, payload và số căn cước chỉ tồn tại trong RAM của process cục bộ. Không gửi đến API OCR/AI/dịch vụ quét bên ngoài; không lưu ảnh/payload vào git hay report.
- Artifact chỉ chứa mã thứ tự mẫu, kích thước/dung lượng ảnh, thời gian và boolean đối chiếu. Mã mẫu không phải ID khách hàng.

## Cách đo

Source ứng dụng tại commit `1d6523fb`; `@zxing/library` 0.22.0, jsQR 1.4.0. Bundle module decoder vào Chrome headless 152 trên Windows, localhost secure context. `BarcodeDetector` không có ở môi trường này; không suy rộng sang mọi Chrome.

1. **Current:** chạy hàm `decodeQrFromFile` hiện tại.
2. **Hints fixed:** đổi đúng lời gọi `reader.decode(bitmap)` thành `reader.decode(bitmap,hints)` trên bản source trong bộ nhớ của harness. Không sửa ứng dụng.
3. **WASM raw:** `zxing-wasm@3.1.3` nhận ImageData nguyên ảnh, chỉ QR, bật tryHarder/rotate/invert/downscale, `textMode: Plain`.
4. **WASM rescue:** nếu chưa có CCCD, thử nguyên bản/phóng 2×/contrast; có tile chồng lấn, nhánh contrast thử denoise; tối đa 24 vùng và deadline mềm 5 giây. Đây là harness nghiên cứu, chưa có watchdog production. Cả 4 ca cứu được xảy ra ở lượt thứ hai: phóng 2× nguyên ảnh.
5. **WeChat:** OpenCV 4.10.0 Python/native CPU, có detector và super-resolution models. Chạy sau khi bộ benchmark browser đã hoàn tất để tránh hai phép đo tranh CPU. Mỗi ảnh khởi động process riêng; thời gian báo cáo chỉ quanh `detectAndDecode`, không gồm Python/model startup.

Model tải từ [kho chính thức OpenCV](https://github.com/opencv/opencv_3rdparty/tree/wechat_qrcode_20210119), đã đối chiếu đủ bốn MD5 với README. Kích thước: detector weights 965430 bytes, detector config 42656, SR weights 23929, SR config 5984. Đây chỉ là dung lượng model/config, **không phải tổng bundle OpenCV chạy trong browser**.

Mỗi ảnh/engine chạy một lần, thứ tự cố định, WASM đã init. Current/fixed bao gồm FileReader và dựng Image; WASM nhận raster đã có. Vì ranh giới thời gian khác nhau, không lấy tỷ số thời gian làm hệ số tăng tốc UI. Chưa test cold start, copy/paste hệ điều hành hay camera thật.

Đếm “CCCD” ở harness khi chuỗi có ít nhất 7 phần phân tách `|`, trường đầu 12 chữ số, trường tên không rỗng. Chưa phải kiểm đầy đủ ngày/thông tin pháp lý; `dbIdMatch` chỉ so trường số với hồ sơ.

## Kết quả

| Phương pháp | Đọc chuỗi có dạng CCCD | Số khớp hồ sơ | Không khớp |
|---|---:|---:|---:|
| Hiện tại | 4 | 4 | 0 |
| Sửa hints | 4 | 4 | 0 |
| WASM raw | 8 | 8 | 0 |
| WASM + rescue | 12 | 12 | 0 |
| WeChat native | 17 | 16 | 1 |

Trong 57 ảnh có cả hai mặt và chưa có nhãn độc lập “QR hiện diện/đọc được”. **Không trình bày 4/57 hay 17/57 là accuracy.** 17 là số ảnh có bằng chứng đọc được trong phép thử này. 40 ảnh còn lại có thể gồm mặt không chứa QR, giấy tờ cũ, ảnh quá kém hoặc QR mà tất cả engine bỏ sót; chưa phân loại.

| Mã mẫu | Hiện tại | WASM raw | WASM rescue bổ sung | WeChat |
|---|---|---|---|---|
| sample-01-front | — | — | — | Có, khác số hồ sơ; đã đối chứng bên dưới |
| sample-03-front | — | — | Có | Có |
| sample-05-front | — | — | — | Có |
| sample-07-front | — | Có | Không cần | Có |
| sample-09-front | — | — | — | Có |
| sample-11-back | Có | Có | Không cần | Có |
| sample-13-back | Có | Có | Không cần | Có |
| sample-15-back | — | Có | Không cần | Có |
| sample-16-front | — | — | Có | Có |
| sample-17-front | — | Có | Không cần | Có |
| sample-18-front | — | — | — | Có |
| sample-19-front | — | — | Có | Có |
| sample-21-front | Có | Có | Không cần | Có |
| sample-23-back | Có | Có | Không cần | Có |
| sample-24-front | — | — | Có | Có |
| sample-28-back | — | Có | Không cần | Có |
| sample-30-front | — | — | — | Có |

Không có ca Current đọc được bị WASM+rescue hoặc WeChat làm mất trong mẫu này. Current còn trả hai chuỗi không phải cấu trúc CCCD; sau sửa hints giới hạn QR, hai kết quả này không còn. Chưa log format của chúng nên không kết luận chúng là loại barcode cụ thể.

### Thời gian có ích để xác định vấn đề

- Current: median toàn mẫu 2699ms, p95 7584ms; chậm nhất 19046ms và vẫn thất bại (`sample-21-back`).
- Current trên ảnh có đọc được: chậm nhất 8908ms (`sample-21-front`).
- `sample-07-front`: Current không đọc sau 7584ms; WASM raw đọc được số khớp hồ sơ trong 14ms ở bước decode raster.
- `sample-03-front`: Current không đọc sau 6126ms; WASM raw không đọc, rescue phóng 2× đọc được (707ms riêng rescue).
- WASM raw+rescue: median 150ms, p95 1203ms tính từ raster đã có; cần đo lại từ Ctrl+V đến tự điền sau triển khai.
- Native WeChat: thời gian riêng detect/decode median 17ms, p95 136ms; chưa gồm init và không đại diện tốc độ WebAssembly.

### Đối chứng trường hợp số không khớp hồ sơ

`sample-01-front`: WeChat trả payload có số khác `customers.id_number`. Để kiểm xem có phải lỗi decoder, dùng chính vùng QR do WeChat định vị, thêm viền và phóng 3× cubic; đưa raster đó sang ZXing-C++ WASM.

Kết quả: ZXing-C++ đọc được và **toàn bộ payload giống hệt WeChat**, số vẫn không khớp hồ sơ. Không có payload/ảnh nào được ghi ra artifact. Kết luận giới hạn: hai thuật toán đồng thuận nội dung QR; cần đối chiếu hồ sơ nếu muốn xử lý dữ liệu. Không tự sửa số, đổi ảnh hay kết luận giấy tờ sai.

## Phát hiện code liên quan

- Hints ZXing bị reset: `src/lib/qrDecoder.ts:193-197`, đã kiểm trực tiếp hành vi của thư viện cài. Sửa một lỗi này không đủ: số ca CCCD vẫn 4.
- Scale chỉ giảm kích thước, không phóng lớn; crop chỉ ở tâm ảnh. Thử nghiệm ảnh thật cho thấy phóng lớn có ích ở 4 ca.
- Không có deadline/worker cho lượt xử lý đồng bộ; các lần thử lại có thể chiếm nhiều giây trên main thread.
- Camera tắt ZXing, chỉ quét ROI giữa; chưa kiểm camera thật nên chưa định lượng lỗi camera.
- Ảnh lưu qua `uploadFile` dùng `compressImage`, cạnh dài 1600px/WebP quality 0.82 khi phù hợp điều kiện nén. Không có ảnh trước lưu để quy lỗi cho nén ở từng mẫu; chính sách giấy tờ cần bảo toàn chi tiết.

## Artifact và tái lập

Thư mục cục bộ ngoài repo:

`C:/Users/Nguyen Tam/.codex/visualizations/2026/09/06/01a07775-314f-77a3-be94-a5719ab6f0a9/qr-research/`

- `real-benchmark.cjs` → `real-results.json`.
- `wechat-benchmark.mjs`, `wechat-probe.py` → `wechat-results.json`.
- `verify-mismatch.mjs`, `verify-crop.py` → `mismatch-verification.json`.
- `summarize-results.cjs` → `real-summary.json`.
- `benchmark.cjs`, `results.json`, `results-extra.json`: 18 biến thể tổng hợp dùng trước khi người dùng cho phép đọc Supabase.
- `wechat-models/`: model công khai, không chứa ảnh khách. Package và lockfile WASM cài riêng ngoài source ứng dụng.

Chạy các benchmark trực tiếp bằng Node ở máy có vault hợp lệ; chúng chỉ đọc database/storage. Không bật trace/screenshot/log request body khi kiểm ảnh thật. Python private IPC của bước verify có chứa payload/crop trong bộ nhớ; parent chỉ ghi các boolean đối chiếu.

## Điều kiện trước khi phát hành

1. Gán nhãn QR và mở rộng bộ ảnh, thêm nhóm lỗi người dùng thực sự so với Zalo; giữ holdout theo ảnh nguồn.
2. Spike tầng WeChat/learned detection trên web, đo toàn bộ chi phí tải/khởi tạo/RAM; không mặc định native thành công nghĩa browser thành công.
3. Đo từ sự kiện paste tới tự điền và camera vật lý; kiểm concurrency/reset/timeout/capabilities.
4. Chạy gate và release theo Contract. Tiến độ code và kiểm thử mới hơn nằm ở phần bổ sung bên dưới; chưa phát hành tính năng.

## Bổ sung kiểm chứng ngày 07/09/2026

Bộ 9 ảnh người dùng gửi được đánh số theo thứ tự tin nhắn gốc; ảnh 2 là ảnh ghép hai mặt, ảnh 5 là thẻ xoay ngang. Không lưu ảnh, payload hoặc nội dung OCR trong báo cáo.

| Lượt kiểm | Đọc QR / 9 ảnh | Giới hạn |
|---|---:|---|
| WeChat native + vùng tự tìm + biến thể | 7 | Chưa phải ứng dụng web |
| WeChat 4.5.5 WASM toàn ảnh trong Chrome | 5 | Các ảnh 1, 4, 6, 7, 8 |
| Cùng WASM + grid/phóng toàn ảnh | 5 | Không thêm ca thắng trong 6 giây |
| WeChat WASM + DNN OpenCV.js 4.12 tự tìm vùng | 7 | Thêm ảnh 3 và 9; ảnh 2/5 vẫn chưa đọc QR |

Lượt learned browser: ảnh 3 đọc ở 1.589 giây (7 lượt), ảnh 9 ở 2.699 giây (13 lượt); hai ảnh thất bại lần lượt 6.019 và 4.112 giây. Init localhost khoảng 175ms, không đại diện cold download ngoài Internet. Kiểm cấu trúc payload ở phép chạy này, chưa đối chiếu từng trường với đáp án độc lập. Asset dùng `qr-scanner-wechat@0.1.3` và `@techstark/opencv-js@4.12.0-release.1`, tự phục vụ localhost và chặn request ngoài origin. `wechat-web.cjs --learned` sinh `wechat-web-learned-results.json` ngoài repo.

OCR browser đã chạy ảnh gốc qua detector/chọn dòng/tự xoay rồi VietOCR FP32. Hai ảnh 2/5 mất 16.522 và 22.440 giây sau init. Sáu dòng tên/địa chỉ giống kết quả native trên cùng vùng chữ, nhưng tương đồng engine không phải đáp án chuẩn (một vị trí dấu Hoà/Hòa đã khác chữ in). Chưa đạt mục tiêu tốc độ, chưa đủ đánh giá chính xác toàn bộ năm trường. Mirror VietOCR chưa đủ hồ sơ phát hành; không gửi ảnh sang dịch vụ AI khác.

P0 sửa hints/retry import và scanner trong cửa sổ tạo khách hàng hợp đồng đã được triển khai ở worktree. Test component thực với React Hook Form: 16/16 test tập trung xanh; mutation đưa lỗi callback cũ trở lại bị test bắt. E2E headless tài khoản DEMO đi từ Hợp đồng tới tạo khách mới, đưa QR giả vào, tự điền đúng số 0 đầu/giới tính/địa chỉ: 1/1 xanh trong 38.1 giây. Quét không tự lưu khách. Đây là kiểm file input, chưa phải clipboard hệ điều hành hay camera vật lý. Chưa phát hành lên production.

Lượt QR bounded giữ 7/9 với tối đa6biến thể mỗi vùng tự tìm: thêm ảnh3 ở595ms và ảnh9 ở729ms; hai ảnh chưa đọc2/5 mất1474/730ms. Đây là điều chỉnh dựa trên bộ development9ảnh, chưa phải holdout. Artifact `wechat-web-bounded-results.json`.

OCR ứng viên `vemines/vietocr-onnx` có license MIT do nhà phân phối công bố và revision ghim; bản quantize dùng12dòng giả để calibration, không dùng ảnh khách. Sáu dòng giữ kết quả FP32, tên cả hai ảnh khớp chữ in; địa chỉ ảnh2 còn khác vị trí dấu. Pipeline browser mới mất5.921/4.656giây sau init617mslocalhost. Chi tiết hash, nguồn và giới hạn trong plan; chưa có parser5trường/luồng tự điền OCR phát hành.


### Kiểm CSP và tài nguyên trình duyệt bổ sung
Artifact WeChat/OpenCV nguyên bản phát sinh `EvalError` dưới `script-src 'self' 'wasm-unsafe-eval'`. Spike thay các wrapper Emscripten sinh hàm từ chuỗi bằng closure thông thường, giữ chuyển đổi tham số/giải phóng/giá trị trả về, đã chạy lại cùng 9 ảnh với CSP: 7/9 QR, init174ms; ảnh3/9 lần lượt624/1367ms. Chưa coi script nghiên cứu là asset production: cần hash ghim, test ngữ nghĩa wrapper và module-worker build thực tế. Không thêm `unsafe-eval` toàn website.
Nhánh OCR cũng chạy được với OpenCV đã sửa CSP: hai ảnh2/5 mất11.8/11.9giây trong lượt máy đang chạy đồng thời build/test, init908ms; kết quả sáu dòng giữ5/6 giống native, khác một ký tự nhãn trước giá trị địa chỉ. Tốc độ nghiên cứu trước4.4–5.7giây không phải cam kết mọi lần chạy; ngân sách OCR phải dựa phép đo worker production và có huỷ tác vụ.
Nguồn model RapidAI/RapidOCR tại ModelScope revisionv3.9.2 khai ApacheLicense2.0 trong README (HTTP200), còn vemines/vietocr-onnx revision049d43e7ba75961d51ab8acad13901f93b08c859 khaiMIT trong modelcard (HTTP200). Model tải ở build/self-host, không gửi ảnh người dùng ra các nguồn này.

Tesseract đối chứng bổ sung: tesseract.js `vie` LSTM SINGLE_LINE trên cùng vùng chữ của hai ảnh khó, khởi tạo455ms, nhận dạng2.186/1.403giây (không gồm detector). Tên ảnh2 không khớp tên đã đối chiếu bằng VietOCR; tên ảnh5 khớp. Bốn dòng địa chỉ/nhãn không giống nguyên văn VietOCR, không dùng khác biệt nhãn để suy ra toàn bộ địa chỉ sai. Kết quả chỉ số trong tesseract-comparison-results.json ngoài repo; không lưu chữ/ảnh khách. Giữ VietOCR cho tầng tiếng Việt vì có ca tên mà baseline này không đọc đúng.


### Đối chứng trực tiếp chính sách nén ảnh đang dùng
Dùng chính hàm `src/lib/imageCompress.ts` của worktree (transpile vào harness, không chép lại thuật toán), chạy trên9PNG người dùng gửi và giải mã cùng pipeline WeChat/DNN giới hạn dưới CSP. Ảnh gốc đọc7/9; ảnh sau chính sách WebP0.82/cạnh1600 đọc5/9, mất hai ca3và9. Không ghi ảnh nén ra đĩa hay upload lên Supabase. Kết quả số đo ở `wechat-storage-comparison-results.json` ngoài repo.
Tổng9ảnh gốc12,733,434byte, sau nén1,464,870byte; giữ nguyên tăng8.69lần dung lượng trong tập PNG clipboard này, trung bình1,414,826byte/ảnh thay162,763byte. Không ngoại suy thành mức tăng cho toàn kho ảnh JPEG thực tế. Đây là bằng chứng trực tiếp cần chính sách `identity-original` cho CCCD mới; không backfill ảnh cũ không có nguồn gốc.


### Worker production và tập kiểm tra bổ sung từ Supabase
BuildDSCydPj7 đọc7/9ảnhdevelopment, sau khi sửa bướcDNN từ thu nhỏRGBA bilinear về grayscale→cubic đúng nhưspike. Biến thểbilinear trước đó chỉ5/9, nên đã bỏ cách tối ưu làm mấtcoverage. BuildcuốiD95aY8j6 (thêmnearest2x đã quaablationảnhgiả) giữ7/9, ảnh3/9 là817/877ms, ảnh1cold518ms gồm231mskhởi tạo;2/5notfound1904/875ms.
Tập mới54ảnh từ30khách hàng sau30kháchdevelopment theo thứ tựmd5 tại snapshotDBhiện tại, loại9sốCCCD củaattachment bằngOCR (9/9đọcđược) và kiểm lạiQRpayload; không trùng9thẻ theo phép kiểm này. Read-only,ảnh vàQRpayload ởRAM. DSCydPj7 đọc12QR, nativeOpenCV4.10raw11QR, không mấtca nativeđọcđược, thêm1ca; mọiQRcảhaiđọc cópayloadnguyênvăngiốngnhau. Không gọi12/54làtỷlệchínhxác vìtập cómặtsau/ảnhkhôngQR. Medianthànhcông237ms,p95thànhcông1267ms; medianmọiảnh1297ms,p954058ms,1timeout,0engine-unavailable.
10/12QRkhớpsốCCCDtronghồsơ,2khácDB; cảhaica khác đều đượcnativevàwebgiải mãgiốngtoànbộpayload. Khôngsửadữliệu khách. Đangchạylạitập54trênartifactD95aY8j6đểgắnđúngsốđovớibảncuối, khôngdùngsốđobảncũ làmchứngminhbảnmới.


Xác minh artifact cuối `qr.worker-D95aY8j6.js` trên cùng tập54ảnh đã hoàn tất:12QRweb/11QRnative, không mấtca nativeđọcđược, thêm1ca, không bất đồng nội dungQR khi cảhaiđọcđược. Có1timeout; median mọi ảnh1576ms, p954146ms; median thành công634ms, p95 thành công1452ms. Hai sốCCCD khácDB vẫn có payload giống hoàn toàn giữa hai engine, không sửa hồ sơ.

### Xác minh sau sửa nhận nhiều QR — 07/09/2026
Worker build Dq0Y5Okv giữ kết quả 7/9 ảnh đính kèm; hai ca 2/5 chưa đọc QR. Trên 54 ảnh của tập kiểm tra bổ sung, web đọc 12, native WeChat đọc 11; không mất ca native nào, thêm một ca, không khác toàn bộ payload ở các ca cùng đọc, không timeout trong lượt này. Tập có ảnh mặt sau/không QR nên 12/54 không phải tỷ lệ chính xác của mã QR. Hai số CCCD không khớp dữ liệu khách trong DB nhưng hai bộ giải mã độc lập cùng trả toàn bộ payload giống nhau; không sửa dữ liệu thật.
Trong 12 payload, 11 có 7 trường và một có 11 trường. Ngày ở tiền tố bảy trường đều là 8 chữ số, giới tính thuộc nhóm đã hỗ trợ; đây là bằng chứng cần giữ tương thích dạng mở rộng khi siết parser, không phải đặc tả chính thức cho mọi CCCD.
Rà soát độc lập tái hiện ảnh giả chứa hai QR khác độ rõ: raw trả một, nearest trả hai, pipeline sửa trả hai với payload đúng. Chrome/Edge production worker qua 10 ca; không cần khởi tạo WeChat khi lượt kiểm ngắn đã có kết quả.
Kiểm soát phát hành đọc lại bằng API: cả ihomecrm và ptcrm-docs đều theo nhánh production; production hiện READY tại 3350509dca0a. Đây là kiểm trước phát hành, không phải bằng chứng tính năng đã lên production.

### Lưu ảnh CCCD gốc — kiểm cả kho thật bằng dữ liệu DEMO
Task3b đã qua review độc lập, tích hợp b4ce0522. Chỉ hai ô CCCD mặt trước/mặt sau ở CustomerForm và CreateCustomerDialog dùng identity-original; các ảnh khác giữ nén mặc định. Test liên quan63/63, TypeScript/strict/lint/build/bundle và mutation đều đạt.
Controller gọi chính uploadFile từ source qua trình duyệt headless, đăng nhập và xác nhận org DEMO trước khi ghi. Ảnh PNG giả964181byte tải lên customer-images, tải lại964181byte cùng SHA256, worker đọc đúng payload QR giả. Xoá fixture và xác nhận bằng danh sách storage; không tạo khách hàng. Các lần sửa harness xác minh đã dọn toàn bộ ảnh thử; không dùng ảnh khách thật. customer-images hiện đi Supabase, R2_PRIVATE_BUCKETS trống, nên live R2 không thuộc đường phát hành này.

### Clipboard và tương thích parser

E2E trên bản build dùng tài khoản DEMO, mở Hợp đồng → chọn khách → tạo mới, điền số điện thoại giả hợp lệ rồi dán QR bằng Clipboard API và Control+V: 1/1 đạt trong 12,4 giây. Các trường được điền, không có yêu cầu tạo khách hoặc tải ảnh lên kho. Đây là clipboard của trình duyệt headless, chưa phải clipboard Windows hay thiết bị camera vật lý.

Chạy parser chặt trên 54 ảnh bổ sung qua worker thật: 12 payload CCCD đọc được đều được chấp nhận, không loại nhầm; gồm 11 payload có 7 trường và một payload có 11 trường. Web đọc 12, native đọc 11, không mất ca native đọc được và không bất đồng toàn bộ payload. Kiểm số CCCD, ngày lịch thật, giới tính và dữ liệu bắt buộc không làm mất tương thích trong tập đã đo. Không suy kết quả này thành cam kết mọi dạng CCCD.

Sau review Task4, callback trả kết quả camera đã được giữ ổn định: test tái hiện số lần khởi động effect tăng 1→2 trước sửa, sau sửa giữ một lần khi mở. Thông báo thành công cũ được xoá khi thay/reset ảnh. Bản bc9e1c2b qua review độc lập; Ctrl+V ở /customers/new (con trỏ ngoài các ô tải ảnh) đạt trong 1,596 giây và E2E Hợp đồng đạt 1/1 trong 3,9 giây, đều không có yêu cầu tạo khách/tải ảnh và không lỗi console. Lượt giữ con trỏ trên ô tải mặt trước được chính ô đó nhận; request upload thử đã bị harness chặn. Không coi lượt này là mất sự kiện paste hay lỗi decoder.
