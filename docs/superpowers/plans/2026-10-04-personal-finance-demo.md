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
