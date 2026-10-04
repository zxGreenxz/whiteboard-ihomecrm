# Ví cá nhân: nghiên cứu, flow và bản demo mobile

Ngày khảo sát: 04/10/2026. Mốc hiện trạng: `a9e82b66`.

## Mở bản demo

- Chạy `npm run dev -- --host 127.0.0.1`; mở `/demos/personal-finance/index.html`.
- Báo cáo có sơ đồ: `/demos/personal-finance/flow.html`.
- Dữ liệu giả lưu ở khóa `ihome:personal-finance-demo:v1`; Quản lý → Đặt lại dữ liệu mẫu để thử từ đầu.
- Không đăng nhập hoặc ghi Supabase. Ảnh chỉ object URL trong phiên; không upload. Voice và đọc hóa đơn là mô phỏng được ghi nhãn trên UI.

## Hiện trạng

Ví hiện hữu ở **Menu → Tài chính → Ví cá nhân**, URL `/finance/personal-wallet`, yêu cầu quyền `personal_finance:view`.
Source: `src/pages/finance/PersonalWalletPage.tsx`, `src/components/shareholders/PersonalTxnDialog.tsx`, `src/hooks/usePersonalTransactions.ts`, `src/lib/personalCategories.ts`.
Có CRUD khoản thu/chi, số tổng, biểu đồ năm, cơ cấu chi và bảng lịch sử. Danh mục hiện là năm gợi ý hard-code; form cho gõ tự do nhưng chưa có quản lý danh mục riêng.

## Nguồn tham khảo và quyết định

| Nguồn chính thức | Điều quan sát được | Thiết kế cho iHomeCRM |
|---|---|---|
| [Rolly](https://rollyapp.ai/) | Nhập chữ, voice, ảnh; phân loại; ví, chart, category tùy chỉnh | Một ô ghi nhanh, bản nháp sửa được; dừng voice tự xử lý |
| [Money Lover: Categories](https://moneylover.zendesk.com/hc/en-us/articles/34045598720025-Category-Definition-and-Usage) | Danh mục thu/chi/vay nợ; category dùng khi nhập, báo cáo và ngân sách | Bộ chọn biểu tượng, tách thu/chi, thêm ngay trong form |
| [Money Lover: cập nhật quản lý category](https://moneylover.zendesk.com/hc/en-us/articles/36614437617177-Explore-the-exciting-new-feature-in-MoneyLover-with-new-update) | Quản lý category dùng cho các ví | Danh mục cá nhân dùng thống nhất giữa các màn |
| [Wallet](https://budgetbakers.com/en/products/wallet/) | Ngân sách, theo dõi chi, planned payments và cashflow | Thấy số còn lại theo ngân sách và danh mục |
| [Spendee](https://www.spendee.com/) | Đồ thị trực quan, tổng thu/chi, nhiều ví, category tùy chỉnh | Tổng quan ngắn, báo cáo chạm tới giao dịch |

Chỉ khảo sát nội dung công khai, không đăng nhập tài khoản trả phí; không xác minh tuyên bố độ chính xác AI, ngân hàng hỗ trợ hoặc bảo mật của nhà cung cấp. Các lựa chọn UI là đề xuất riêng, không phải tính năng đối thủ đã thử trực tiếp.

## Phạm vi demo

- Tổng quan, lịch sử lọc tháng/loại/ví/tìm kiếm; CRUD khoản; xác nhận xóa.
- Ghi nhanh nhiều khoản tách bằng dấu `;`, các ví dụ tiếng Việt; thiếu số tiền báo lỗi; nhập tay dự phòng.
- Voice mẫu tự gửi sau dừng; ảnh kèm nội dung; ảnh không có mô tả phải dùng dữ liệu hóa đơn mẫu hoặc nhập nội dung, không giả vờ OCR.
- 16 danh mục chi và 7 danh mục thu; thêm tên/emoji, chống tên trùng cùng loại, chọn ngay và giữ form đang nhập.
- Ví ngân hàng, tiền mặt, tiết kiệm; thêm ví; chuyển ví không tính thu/chi.
- Ngân sách tháng, ngân sách theo danh mục, mục tiêu và góp quỹ bằng chuyển ví.
- Báo cáo cơ cấu, dòng tiền sáu tháng, drill-down, xuất CSV dữ liệu mẫu.
- Giao diện đáp ứng 320–430px và desktop; dialog bàn phím, safe area và reduced motion.

Demo dùng ngày giả lập 04/10/2026. Tính năng góp quỹ trong demo không cho sửa/xóa giao dịch đã gắn mục tiêu để tránh lệch tiến độ; khi triển khai thật cần ledger quỹ và xử lý đảo giao dịch.

## Tích hợp sau demo

Giữ route và quyền hiện hữu. Viết migration forward cho category/wallet/budget/goal nếu schema hiện tại chưa đáp ứng; chủ sở hữu là user, không tự mở quyền cho admin tổ chức. Giữ nguyên category cũ và không tự đổi cách hiểu khoản ứng công ty.

STT/OCR dùng luồng Quick Entry hiện có, UI phân biệt gửi để tạo nháp với lưu khoản. Production cần trạng thái saving/unknown, reconcile khi kết quả ghi chưa rõ, idempotency và atomic transfer. Kiểm RLS hai actor, phép tính đủ pagination, reconcile v1/v2, mobile thiết bị thật và CI đúng SHA trước promote. Bản demo không thay thế bằng chứng này.

## Kiểm chứng

- Playwright: **8/8 đạt**, tạo/sửa/xóa khoản; category tùy chỉnh và chống trùng; voice tự tạo nháp; ảnh kèm hai khoản; transfer không đổi tổng tiền/thu/chi; ngân sách, góp quỹ, report drill-down; nội dung nhập không chạy HTML.
- Layout: **320, 390, 430, 1280px**, cả bốn màn hình và báo cáo flow; không tràn ngang toàn trang. Ảnh kiểm UI ở `test-results/` (ignored). Không có console/page error trong suite; toàn bộ request nghiệp vụ ngoài server demo bị chặn.
- `npm run typecheck:e2e`: đạt. `npm run docs:check`: đạt.
- `npm run build` và `npm run gate:bundle`: đạt. Demo được copy đủ 5 file vào `dist/demos/personal-finance/`.
- `npm run gate:truoc-push`: **46 gate xanh**, gồm typecheck/baseline, strict/lint và phép đo cách ly org. Generated inventory chỉ tăng theo spec mới.
- Chưa kiểm iPhone/Android thật, bàn phím mobile thật, mic/STT/OCR thật, đồng bộ backend hoặc production. Không dùng kết quả demo làm bằng chứng cho các phần này.

Báo cáo trực quan nằm cạnh demo, không phụ thuộc Mermaid hoặc API ngoài để vẽ sơ đồ. Các gate không yêu cầu vai trò app trong demo vì không thay route được bảo vệ, quyền hay writer đang chạy; khi tích hợp dữ liệu thật phải chạy kiểm theo vai trò ở DEMO/TEST.
