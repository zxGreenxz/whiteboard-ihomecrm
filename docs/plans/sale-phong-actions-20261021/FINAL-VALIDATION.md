# Kiểm chứng bản local — 21/10/2026

## Phạm vi và kết quả

- [103 ca theo vai trò và kênh](ROLE-ACCEPTANCE.md): 78 yêu cầu web/Hermes và 25 kiểm tra quyền/dữ liệu PostgreSQL; một nghiệp vụ có thể được kiểm ở nhiều tầng. Đủ Chủ trọ, Quản lý, Chủ công ty, Sale Admin và Sale.
- Trình duyệt Chromium: **13/13** ca trên desktop và mobile 390px; 0 lỗi trang, 0 request ra ngoài. Component thật, backend/auth/storage giả lập. Bằng chứng: `test-results/sale-quick-local/ui-browser-results.json` và ảnh `ui-*.png`.
- Luồng tiền: **8/8** ca PostgreSQL thật; gồm tranh phòng giữa hai phiên và báo cọc → ghi sổ qua writer canonical. Chứng từ có metadata giả lập, chưa phải upload Storage thật.
- Web/Hermes đồng thời: **6/6** ca PostgreSQL thật, có xác nhận chờ khóa giữa hai kết nối.
- Mutation nghiệp vụ: **10/10** bị bắt (4 metadata/phân quyền + 6 cọc/kỳ hạn/thực nhận). Không giữ mutant trong source hoặc database.
- TypeScript: **0 lỗi**, không nới baseline. Strict islands đạt trong lượt gate tổng đầu.
- Build ứng dụng cuối: **PASS**, 30,65 giây; URL/key build chỉ là local giả lập.
- Lint toàn repository: **chưa sạch** — 933 lỗi, 240 cảnh báo ở lượt đo rộng. Riêng 55 file TS/TSX thay đổi có 12 lỗi `no-explicit-any` thuộc ba file cũ: SaleImagesTab 2, MobileSaleInfo 3, useDeposits 7; đã lint trực tiếp nội dung HEAD để xác nhận cả ba có đúng số lỗi đó trước thay đổi. Ratchet lint của repository đạt, không cập nhật baseline để che lỗi.

## Kiểm tổng

Lượt đầu `npm run gate:truoc-push`: **43/48**, chưa đạt. Đã dùng kết quả để sửa:

1. Giả lập các API Hermes mới và mẫu quyền “không hỗ trợ” đã lỗi thời; giữ kiểm không tự cấp quyền.
2. Kiểu tham số của test giao diện và quy ước đọc bộ nhớ nháp tùy chọn.
3. Phân loại file tái hiện lỗi trước sửa thành `.proof.ts`; test hồi quy thật vẫn nằm trong các suite đang chạy.
4. Kiểm ACL cho hai helper thuần INVOKER và năm RPC mới, kèm mutation.
5. Chứng minh nhánh Copilot trong writer tương thích không thể được gọi từ payload cọc canonical; vẫn quét các đường gọi khác, kèm mutation. Không sửa writer dùng chung hay reader Claude.
6. Giới hạn `node-native` local ở hai tiến trình: cùng danh sách test, không đổi CI. Tám lỗi khởi động PostgreSQL khi chạy dồn đã được tái hiện; một file chạy riêng đạt 9/9 trong khoảng 9 giây.

Lượt tiếp theo đạt **46/48**: toàn bộ `node-native`, TypeScript/strict và các kiểm tra mã đạt. Còn một link tài liệu cũ và hai file test điều phối: kỳ vọng dòng lệnh chưa có giới hạn tiến trình, hai ca Git-history hết thời gian khi chạy dồn. Đã sửa link và giữ nguyên danh sách test, không tăng timeout; runner Vitest liên quan cũng giới hạn hai worker local. Kết quả lượt xác nhận sau các sửa này nằm tại `test-results/sale-quick-local/final-gate-confirmation.log`; chỉ dòng `Local: 48/48 đạt` cùng exit code 0 mới chứng nhận lượt đó đạt. Các con số 43/48 và 46/48 ở đây được giữ để minh bạch các lỗi đã tìm thấy.

## Nguồn bằng chứng bổ sung

Các file dưới `test-results/sale-quick-local/` được giữ local:

- `hermes-native-fixture-fixes.tap`: 111/111 test máy chủ/đăng ký quyền.
- `hermes-v8-ui-fixture-results.json`: 123/123 test giao diện/chính sách/kết nối Hermes.
- `quick-board-gate-fixes.json`: 54/54 test bảng và nháp sau sửa kiểu test.
- `gate-registry-review-results.json`: 71/71 test chọn gate và điều phối, đã review độc lập.
- `typecheck-final.log`, `build-final.log`, `lint-final.log`, `lint-head-comparison.json`.
- `candidate-idempotence.log`, `quick-final-apply.log`: áp lại migration trên database local.
- `inventory-performance.json`: SQL với 503 phòng tổng hợp, không phải đo tải production.

## Chưa xác minh

Chưa kiểm HTTP JWT/PostgREST với Supabase đầy đủ, Storage thật, provider Zalo thật, hội thoại LLM thật, browser-back/router toàn ứng dụng khi upload, tải lớn từ trình duyệt hoặc CI của commit phát hành. PostgreSQL local là **17.10**, khác bản **17.6** ghim trong Contract. Các bài DEFERRED hoặc SKIPPED không được tính là PASS.

Không có push/deploy, áp migration từ xa, bật capability production hoặc thay đổi checkout của Claude. Cần hoàn tất lane TEST/CI và các kiểm tra còn thiếu trước khi phát hành. Việc “toàn bộ production đã tối ưu” chưa được chứng minh.
