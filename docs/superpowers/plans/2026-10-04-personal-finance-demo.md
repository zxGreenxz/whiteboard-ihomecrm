# Demo ví cá nhân ưu tiên điện thoại

**Mục tiêu:** Báo cáo tham khảo, sơ đồ luồng và demo tương tác cho người dùng duyệt trước khi tích hợp ví cá nhân mới.

**Phạm vi:** Yêu cầu mới mở rộng từ danh mục sang bản demo quản lý thu chi. Giữ hệ thống đang chạy; demo dùng dữ liệu giả và localStorage riêng. Không nối ngân hàng, không nhận diện ảnh hoặc thu âm thật, không ghi Supabase.

**Thiết kế:** Tổng quan → Giao dịch → nút Ghi khoản → Kế hoạch → Báo cáo. Danh mục và ví ở menu quản lý. Chữ/voice mẫu/ảnh mẫu đều tạo bản nháp để sửa trước khi lưu. Kết thúc voice mẫu tự tạo nháp, không phải bấm gửi thêm. Ảnh có thể kèm chữ/voice. Chuyển ví không tính là thu/chi. Danh mục thu và chi riêng; thêm ngay từ bộ chọn. Báo cáo bấm xuống danh sách giao dịch.

**Kiến trúc:** `public/demos/personal-finance/index.html`, `styles.css`, `model.js` (dữ liệu và tính toán), `app.js` (tương tác), `flow.html` (báo cáo + sơ đồ). Tài liệu nghiên cứu ở `docs/prototypes/personal-finance.md`. JavaScript thuần, CSS đáp ứng, không thêm thư viện hoặc API.

- [x] Nghiên cứu nguồn chính thức Rolly, Money Lover, Wallet, Spendee; đối chiếu ví hiện hữu.
- [x] Tạo danh mục thu/chi, dữ liệu mẫu, kiểm tra số tiền/ngày, chuyển ví và bộ lọc.
- [x] Tạo giao diện mobile: điều hướng dưới, form dạng sheet, danh mục biểu tượng, quản lý ngân sách/mục tiêu.
- [x] Tạo báo cáo có sơ đồ luồng, phạm vi hiện hữu/demo/tích hợp sau, nguồn tham khảo.
- [x] Playwright kiểm thêm/sửa/xóa, danh mục mới, lưu lại khi tải lại, chuyển ví, ngân sách, lọc báo cáo; kiểm 320/390/430/1280px và console.
- [x] Kiểm bản build và gate phù hợp, gửi yêu cầu mở demo và báo cáo trong Codex; ghi rõ giới hạn.

## Tiêu chí thao tác

- Nút chạm tối thiểu 44px, nhập liệu 16px, safe-area và không cuộn ngang ở 320px.
- Tiền VND nguyên dương; báo lỗi tại form; nội dung người dùng được escape.
- Dữ liệu mẫu lưu một khóa riêng `ihome:personal-finance-demo:v1`; reset chỉ xóa demo.
- Các số trên tổng quan, ngân sách, báo cáo đều tính từ cùng danh sách giao dịch.
- Ảnh chỉ preview trong phiên, không upload hoặc lưu localStorage.
- Có đường nhập tay khi mô phỏng không hiểu câu, có trạng thái trống và xác nhận xóa/reset.
- Không đưa chức năng chưa nối backend thành tính năng production đã xong.

## Chỉnh thiết kế ngày 05/10/2026 — nơi gửi thu chi

Người dùng yêu cầu bỏ nhãn DEMO, dòng giải thích mô phỏng và ba nút nhập mẫu trong giao diện; thêm nút gạt Cá nhân / Công ty dưới ô nhập. Người dùng chốt rõ: chỉ chỉnh bản thiết kế đang xem, chờ duyệt hết thiết kế mới hiện thực trong ứng dụng thật.

- [x] `app.js`, `styles.css`, `index.html`: bỏ nhãn trên màn chính và khối mẫu trong form; thêm bộ chọn nơi gửi dưới bốn nút ở Tổng quan và Ghi nhanh; giữ chữ, ảnh và dữ liệu form khi chuyển.
- [x] Bản nháp giữ nơi gửi tại thời điểm bấm Gửi. Trong bản thiết kế, các khoản công ty thử nghiệm nằm ở `state.companyTransactions`, không nhập vào số dư hoặc báo cáo cá nhân. Không thêm API hay sửa writer production.
- [x] Cập nhật E2E: nơi gửi, dữ liệu nhập, nháp, không lẫn sổ cá nhân; kiểm bố cục 320/390/452px, mẫu đã bỏ và bốn nút còn hoạt động. 11/11 đạt.
- [x] Kiểm build, bundle, typecheck E2E, docs; 46 gate xanh trong 67 giây. Mở lại đúng tab cho người dùng xem. Ghi yêu cầu tương ứng cho lần tích hợp thật, không merge/promote khi đang duyệt thiết kế.

## Tinh gọn Tổng quan và cấu hình ví — 05/10/2026

- Bỏ heading/mô tả trên stat; chuyển bộ chọn tháng định dạng `9.2026` sang bên trái con mắt trong thẻ số dư.
- Bỏ đầu khung gợi ý; chỉ giữ ô nhập, bốn nút và Cá nhân / Công ty bên dưới.
- Trong bộ lọc ví có Thêm ví và Quản lý ví. Danh sách quản lý cho sửa từng ví; form có tên, loại, biểu tượng, số dư ban đầu và hiển thị trên Tổng quan.
- Ví chưa có giao dịch/liên kết được xóa sau xác nhận; ví đang dùng cho lịch sử, mặc định hoặc mục tiêu được giữ và có lựa chọn ẩn. Ẩn không xóa lịch sử, không loại số dư khỏi tổng.
- Chỉ sửa prototype và tài liệu. Kiểm E2E cho tạo/sửa/ẩn/xóa, giữ liên kết giao dịch, bố cục mobile; chạy build, bundle, typecheck E2E và gate trước khi cập nhật draft PR.

## Bổ sung trong lúc duyệt — danh mục, ngân sách và toàn bộ header

- [x] Đổi nhãn Kế hoạch → Ngân sách; thêm quản lý danh mục (tên, biểu tượng, ẩn/xóa có điều kiện), tạo danh mục ngay trong form ngân sách và giữ số tiền đang nhập.
- [x] Làm rõ ngân sách tổng tháng và hạn mức danh mục tính trên mọi ví cá nhân, loại chuyển ví và công ty. Kiểm nhiều ví, đổi tháng, liên kết category và hạn mức lặp lại.
- [x] Bỏ topbar logo/cài đặt/TÔI cùng heading/mô tả trên cả bốn màn. Tháng ngắn đặt trong nội dung: cạnh tìm kiếm, tiêu đề ngân sách, phía trái Chi/Thu của báo cáo.
- [x] Playwright 16/16 đạt trên bản cuối: không tràn 320/390/430/1280px, bộ lọc đúng vị trí và giữ từ khóa khi đổi tháng. Các chức năng ví/danh mục vẫn localStorage; người dùng chưa chốt để tích hợp thật.
