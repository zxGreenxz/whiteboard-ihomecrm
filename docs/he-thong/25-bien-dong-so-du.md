# Biến động số dư

Trang `/bien-dong-so-du` là hộp tiếp nhận toàn hệ thống dành riêng cho **super admin**. Chủ công ty, Admin của công ty và kế toán chưa được mở trang này. Quyền được kiểm bằng `is_super_admin()` phía máy chủ; bộ chọn công ty không giới hạn trang tổng.

## Các màn hình

- **Tin nhận được:** lọc theo nguồn, loại tin, mã sự kiện và thời điểm máy chủ nhận. Ngày lọc dùng giờ Việt Nam. Mỗi trang tối đa 25 tin; danh sách chỉ có thông tin nguồn và thời gian. Bấm một dòng mới tải nội dung nguyên văn.
- **Nguồn kết nối:** tạo nguồn riêng cho từng điện thoại, cấp lại khóa, tạm dừng hoặc thu hồi. Khóa chỉ hiện sau lần tạo/cấp lại và phải sao chép vào iHome Gateway trước khi đóng. Khóa cũ mất hiệu lực khi cấp lại; thu hồi là vĩnh viễn, không xóa tin đã nhận.
- **Vận hành:** trạng thái tiếp nhận, địa chỉ webhook đã cấu hình và thông tin điện thoại gửi gần nhất. Email chưa được kết nối trong giai đoạn này.

Khi trang đang được xem, danh sách ở trang đầu cùng thông tin nguồn và vận hành tự cập nhật mỗi 15 giây; các trang tin cũ và nội dung chi tiết không được tải lại định kỳ.

## Kết nối điện thoại

1. Mở **Nguồn kết nối → Thêm nguồn**, nhập tên dễ nhận diện.
2. Sao chép địa chỉ webhook và khóa một lần vào iHome Gateway. Nếu chưa thấy địa chỉ webhook được xác nhận, hoàn tất cấu hình máy chủ trước.
3. Chọn SMS hoặc các ứng dụng được phép chuyển thông báo; cấp quyền trên Android và bật chuyển tiếp.
4. Gửi tin thử, làm mới trang tổng và mở chi tiết để xác nhận nguồn nhận đúng. Tin thử được ghi rõ là dữ liệu giả lập.

## Giới hạn và dữ liệu nhạy cảm

SMS có thể bao gồm OTP và tin cá nhân. Dữ liệu nguyên văn không nằm trong danh sách, cache truy vấn, thông báo lỗi hoặc log của giao diện. Chỉ mở chi tiết qua API đã xác thực. Khóa cấp nguồn nằm trong bộ nhớ màn hình trong thời gian hộp thoại mở, không lưu vào localStorage hoặc cache mutation. Đổi tài khoản hoặc rời trang phải bỏ dữ liệu cũ; các query có mã người dùng trong khóa cache.

Nguồn giữ dấu vết thiết bị và công ty nếu đã được xác minh để có thể phân quyền tổ chức sau. Giai đoạn này chưa cấp ACL nhân viên, chưa tự gắn tin chưa phân loại vào công ty đang chọn, chưa tự hạch toán, xác nhận thanh toán hoặc cộng tin nhắn thành doanh thu/số dư. Tìm kiếm chỉ dựa trên tên nguồn/mã sự kiện, không tìm trong nội dung mã hóa. Android hoặc ngân hàng có thể ẩn nội dung thông báo.

## Nguồn triển khai và kiểm chứng

- Giao diện: `src/pages/bank-events/BankEventsPage.tsx`.
- Service/validation: `src/lib/bank-events/service.ts`; truy vấn theo tài khoản: `src/hooks/bank-events/useBankEvents.ts`.
- Guard: `src/components/auth/RequireSuperAdmin.tsx`; navigation dùng `superAdminOnly` trong capability registry.
- API quản trị: `bank-event-admin`; API kiểm lại JWT và tier super admin ở mỗi yêu cầu.
- Test trình duyệt fixture: `.e2e-fleet/specs/bank-events.spec.ts`. Fixture chỉ dùng dữ liệu giả; kiểm này không thay bằng chứng JWT/RLS thật hoặc nhận SMS từ thiết bị.

Khi API báo chưa xác định kết quả ghi, tải lại danh sách trước khi thử lại. Nếu nguồn đã tạo nhưng khóa chưa được giữ, dùng **Cấp lại khóa**; không thử tạo thêm nguồn một cách tự động.
