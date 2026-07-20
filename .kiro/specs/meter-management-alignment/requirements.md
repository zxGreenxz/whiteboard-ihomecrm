# Tài liệu Yêu cầu - Căn chỉnh trang Quản lý Đồng hồ Công tơ

> **Lifecycle:** historical Kiro spec. Nguồn hiện hành: `docs/he-thong/06-cong-to-chi-so.md`, `docs/huong-dan-su-dung/01-bat-dau/cong-to/` và code trang cài đặt công tơ.

## Giới thiệu

Tài liệu này ghi lại yêu cầu căn chỉnh theo hướng dẫn Resident đã được thay thế. Các gap bên dưới chỉ là snapshot lịch sử và phải tái kiểm chứng.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Công_tơ**: Đồng hồ đo lường tiện ích (điện, nước, gas) được gắn vào phòng, lưu trong bảng `meters`
- **Danh_sách_công_tơ**: Màn hình hiển thị tất cả Công_tơ được nhóm theo Phòng tại đường dẫn Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Tòa_nhà**: Đơn vị quản lý cấp cao chứa nhiều Phòng, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Tòa_nhà, lưu trong bảng `rooms`
- **Loại_công_tơ**: Phân loại Công_tơ theo tiện ích: ELECTRICITY (Điện), WATER (Nước), GAS (Gas)
- **Mã_công_tơ**: Mã định danh duy nhất của Công_tơ (VD: CTD-201, CTN-201)
- **Form_công_tơ**: Dialog/màn hình chi tiết để thêm hoặc sửa thông tin Công_tơ
- **Soft_delete**: Cơ chế xoá mềm bằng cách cập nhật trường `deleted_at` thay vì xoá dữ liệu thật

## Yêu cầu

### Yêu cầu 1: Hiển thị Danh sách Công tơ theo Phòng

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả Công_tơ được nhóm theo Phòng, để tôi có thể quản lý thông tin công tơ thực tế tại căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ, THE Hệ_thống SHALL hiển thị Danh_sách_công_tơ được nhóm theo Phòng, mỗi nhóm có tiêu đề là tên Phòng
2. THE Hệ_thống SHALL hiển thị mặc định 2 Loại_công_tơ cho mỗi Phòng: Công tơ điện (ELECTRICITY) và Công tơ nước (WATER)
3. THE Hệ_thống SHALL hiển thị các thông tin sau cho mỗi Công_tơ trong bảng: Mã_công_tơ, tên Công_tơ, Loại_công_tơ, trạng thái hoạt động
4. THE Hệ_thống SHALL hiển thị nút "Sửa" (text) và nút "Xoá" (text) cho mỗi Công_tơ trong cột Thao tác
5. THE Hệ_thống SHALL chỉ hiển thị Công_tơ chưa bị Soft_delete (deleted_at IS NULL) và thuộc quyền sở hữu của Người_dùng đang đăng nhập

### Yêu cầu 2: Thêm Công tơ mới

**User Story:** Là một Người_dùng, tôi muốn thêm Công_tơ mới cho Phòng, để tôi có thể theo dõi chỉ số tiện ích theo đúng thực tế tại căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị Form_công_tơ với tiêu đề "Thêm công tơ"
2. THE Hệ_thống SHALL hiển thị các trường bắt buộc được đánh dấu (*): Tòa_nhà (*), Phòng (*), Loại_công_tơ (*), Mã_công_tơ (*)
3. THE Hệ_thống SHALL hiển thị các trường không bắt buộc: chỉ số ban đầu, ngày lắp đặt, ghi chú vị trí, nhà sản xuất, model, số serial, ghi chú
4. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút "Lưu", THE Hệ_thống SHALL tạo Công_tơ mới và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. WHEN Hệ_thống tạo Công_tơ mới thành công, THE Hệ_thống SHALL hiển thị Công_tơ mới trong Danh_sách_công_tơ
6. IF Người_dùng nhập Mã_công_tơ đã tồn tại, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Mã công tơ đã tồn tại"
7. IF Người_dùng không điền đầy đủ các trường bắt buộc và ấn "Lưu", THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường thiếu

### Yêu cầu 3: Sửa thông tin Công tơ

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin Công_tơ đã có, để tôi có thể cập nhật thông tin theo đúng thực tế.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút "Sửa" trên một Công_tơ tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị Form_công_tơ với tiêu đề "Sửa công tơ" và thông tin Công_tơ đã được điền sẵn
2. WHEN Người_dùng cập nhật thông tin và ấn nút "Lưu", THE Hệ_thống SHALL lưu thay đổi và hiển thị thông báo cập nhật thành công
3. THE Hệ_thống SHALL tự động cập nhật trường updated_at khi Công_tơ được sửa (thông qua database trigger)

### Yêu cầu 4: Xoá Công tơ

**User Story:** Là một Người_dùng, tôi muốn xoá Công_tơ không còn sử dụng, để danh sách công tơ phản ánh đúng thực tế.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút "Xoá" trên một Công_tơ tại Danh_sách_công_tơ, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận với nội dung chính xác: "Bạn đang thực hiện thao tác xoá công tơ. Bạn có chắc chắn muốn xoá không?"
2. WHEN Người_dùng ấn nút "Xoá" trong hộp thoại xác nhận, THE Hệ_thống SHALL thực hiện Soft_delete (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. WHEN Người_dùng ấn nút "Hủy" hoặc đóng hộp thoại xác nhận, THE Hệ_thống SHALL đóng hộp thoại và giữ nguyên Công_tơ trong danh sách
4. THE Hệ_thống SHALL không hiển thị Công_tơ đã bị Soft_delete trong Danh_sách_công_tơ

### Yêu cầu 5: Nút Thêm công tơ (dấu +)

**User Story:** Là một Người_dùng, tôi muốn có nút thêm công tơ rõ ràng tại thanh công cụ, để tôi có thể nhanh chóng thêm công tơ mới.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị nút có biểu tượng dấu (+) tại thanh công cụ phía trên Danh_sách_công_tơ
2. WHEN Người_dùng ấn nút dấu (+), THE Hệ_thống SHALL mở Form_công_tơ ở chế độ thêm mới với tất cả trường trống

### Yêu cầu 6: Thông báo thành công đúng theo tài liệu

**User Story:** Là một Người_dùng, tôi muốn nhận thông báo thành công đúng nội dung theo tài liệu hướng dẫn, để trải nghiệm nhất quán với tài liệu.

#### Tiêu chí chấp nhận

1. WHEN Hệ_thống tạo Công_tơ mới thành công, THE Hệ_thống SHALL hiển thị toast thông báo với nội dung chính xác: "Dữ liệu đã được TẠO thành công"
2. WHEN Hệ_thống xoá Công_tơ thành công, THE Hệ_thống SHALL hiển thị toast thông báo với nội dung chính xác: "Dữ liệu đã được XOÁ thành công"

### Yêu cầu 7: Dọn dẹp code trùng lặp

**User Story:** Là một lập trình viên, tôi muốn loại bỏ trang quản lý công tơ cũ trùng lặp, để codebase sạch sẽ và tránh nhầm lẫn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL chỉ sử dụng một trang duy nhất cho quản lý Công_tơ tại đường dẫn Cài đặt hệ thống → Danh mục khác → Tài chính → Đồng hồ Công tơ
2. THE Hệ_thống SHALL loại bỏ trang cũ `src/pages/settings/categories/MetersPage.tsx` nếu trang đó không còn được sử dụng trong routing

### Yêu cầu 8: Form Công tơ phù hợp với tài liệu

**User Story:** Là một Người_dùng, tôi muốn form thêm/sửa công tơ chỉ chứa các trường cần thiết theo tài liệu, để giao diện đơn giản và dễ sử dụng.

#### Tiêu chí chấp nhận

1. THE Form_công_tơ SHALL hiển thị các trường bắt buộc với ký hiệu (*): Tòa_nhà, Phòng, Loại_công_tơ, Mã_công_tơ
2. THE Form_công_tơ SHALL hiển thị các trường không bắt buộc: chỉ số ban đầu, ngày lắp đặt, ghi chú vị trí, nhà sản xuất, model, số serial, ghi chú
3. THE Form_công_tơ SHALL có nút "Lưu" để xác nhận thao tác và nút "Hủy" để đóng form
4. WHEN Người_dùng chọn Tòa_nhà, THE Form_công_tơ SHALL cập nhật danh sách Phòng tương ứng với Tòa_nhà đã chọn
