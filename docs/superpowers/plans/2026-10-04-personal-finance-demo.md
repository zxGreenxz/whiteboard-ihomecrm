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
