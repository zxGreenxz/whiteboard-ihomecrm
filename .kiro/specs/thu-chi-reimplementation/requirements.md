# Tài liệu Yêu cầu - Tái triển khai Thu chi (Income/Expense)

## Giới thiệu

Tính năng này tái triển khai hoàn toàn module Thu chi (Income/Expense) trong hệ thống quản lý bất động sản Resident. Module bao gồm 3 phần chính: (1) Quản lý Phiếu thu/chi tại Quản lý & Vận hành → Tài chính → Thu chi, (2) Quản lý Loại thu chi tại Cài đặt hệ thống → Danh mục khác → Tài chính → Loại thu chi, và (3) Quản lý Mẫu in thu chi tại Cài đặt hệ thống → Mẫu biểu → Mẫu thu chi. Hệ thống hiện tại có code frontend cơ bản (PaymentsPage, usePayments, useIncomeExpenseTypes) nhưng chưa khớp 100% với tài liệu hướng dẫn chính thức. Cần tái triển khai lại toàn bộ giao diện, logic nghiệp vụ, database schema, và đảm bảo tích hợp đúng với các module liên quan (Căn hộ, Phòng, Giường, Khách hàng, Hoá đơn, Sổ quỹ).

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Phiếu_thu_chi**: Bản ghi ghi nhận một khoản thu hoặc chi phát sinh, lưu trong bảng `income_expenses`
- **Phiếu_thu**: Phiếu_thu_chi có loại là INCOME, ghi nhận khoản tiền thu vào
- **Phiếu_chi**: Phiếu_thu_chi có loại là EXPENSE, ghi nhận khoản tiền chi ra
- **Hạng_mục**: Dòng chi tiết trong Phiếu_thu_chi, mỗi phiếu có thể có nhiều hạng mục, lưu trong bảng `income_expense_items`
- **Loại_thu_chi**: Danh mục phân loại các khoản thu chi (tiền thuê, phí dịch vụ, tiền phạt, chi phí sửa chữa...), lưu trong bảng `income_expense_types`
- **Mẫu_thu_chi**: Mẫu in biên lai thu/chi dùng để in phiếu, lưu trong bảng `income_expense_templates`
- **Trạng_thái_duyệt**: Trạng thái phê duyệt của Phiếu_thu_chi, gồm UNAPPROVED (Bỏ duyệt/Chưa duyệt) và APPROVED (Đã duyệt)
- **Căn_hộ**: Tòa nhà trong hệ thống, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Căn_hộ, lưu trong bảng `rooms`
- **Giường**: Đơn vị cho thuê nhỏ hơn thuộc Phòng (cho KTX/Sleepbox), lưu trong bảng `beds`
- **Khách_hàng**: Khách thuê trong hệ thống, lưu trong bảng `tenants`
- **Sổ_quỹ**: Module báo cáo tài chính tổng hợp thu chi theo ngày
- **Màn_thu_chi**: Màn hình chính của module Thu chi tại Quản lý & Vận hành → Tài chính → Thu chi
- **Mã_phiếu**: Mã tự sinh cho mỗi Phiếu_thu_chi, định dạng PT{YYMM}{sequence} cho phiếu thu, PC{YYMM}{sequence} cho phiếu chi

## Yêu cầu

### Yêu cầu 1: Lập Phiếu thu

**User Story:** Là một Người_dùng, tôi muốn lập Phiếu thu để ghi nhận các khoản tiền thu vào tại Căn hộ, bao gồm cả các khoản thu phát sinh ngoài hoá đơn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập mục Thu chi từ thanh công cụ và ấn nút dấu (+), THE Hệ_thống SHALL hiển thị màn hình Thêm phiếu thu/chi với hai lựa chọn: Phiếu thu và Phiếu chi
2. WHEN Người_dùng chọn ô Phiếu thu, THE Hệ_thống SHALL hiển thị form với các trường: Căn hộ (*), Phòng, Giường, Khách hàng, Tên phiếu thu (*), Ngày thu (*)
3. THE Hệ_thống SHALL đánh dấu các trường bắt buộc bằng ký hiệu (*)
4. WHEN Người_dùng ấn nút dấu (+) tại phần Hạng mục, THE Hệ_thống SHALL hiển thị màn hình chọn Hạng_mục với danh sách Loại_thu_chi có sẵn và nút Thêm để tạo Loại_thu_chi mới
5. WHEN Người_dùng tích chọn Hạng_mục, THE Hệ_thống SHALL hiển thị thông tin Hạng_mục ra màn hình Chi tiết Thu/chi với các trường chi tiết cho mỗi hạng mục (số lượng, đơn giá, thành tiền)
6. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Phiếu_thu mới với Trạng_thái_duyệt là UNAPPROVED, tự động sinh Mã_phiếu, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
7. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường

### Yêu cầu 2: Lập Phiếu chi

**User Story:** Là một Người_dùng, tôi muốn lập Phiếu chi để ghi nhận các khoản tiền chi ra tại Căn hộ, bao gồm chi phí sửa chữa, bảo trì, và các khoản chi phát sinh khác.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng chọn ô Phiếu chi tại màn hình Thêm phiếu thu/chi, THE Hệ_thống SHALL hiển thị form với các trường: Căn hộ (*), Phòng, Giường, Khách hàng, Tên phiếu chi (*), Ngày chi (*), Hạng mục chi
2. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Phiếu_chi mới với Trạng_thái_duyệt là UNAPPROVED, tự động sinh Mã_phiếu, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
3. THE Hệ_thống SHALL cho phép thêm nhiều Hạng_mục cho một Phiếu_chi, mỗi Hạng_mục có thông tin chi tiết riêng
4. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường
