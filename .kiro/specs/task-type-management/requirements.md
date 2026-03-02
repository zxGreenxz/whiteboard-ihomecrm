# Tài liệu Yêu cầu - Quản lý Loại công việc (Task Type Management)

## Giới thiệu

Trong phần mềm quản lý Bất động sản Resident, trang Loại công việc nằm tại Cài đặt hệ thống > Danh mục khác, cho phép quản lý danh mục loại công việc dùng trong vận hành và bảo trì tòa nhà/căn hộ. Việc phân loại công việc giúp hệ thống tự động phân công công việc đến đúng bộ phận, xử lý nhanh hơn, và hỗ trợ theo dõi tiến độ cũng như báo cáo.

Hệ thống hiện có database schema sẵn gồm các bảng `job_types` (loại công việc), `job_groups` (nhóm công việc), và `departments` (bộ phận thực hiện) với RLS policies. Cần triển khai giao diện React cho trang quản lý Loại công việc bao gồm: (1) Danh sách loại công việc, (2) Thêm mới loại công việc, (3) Sửa loại công việc, (4) Xoá loại công việc, (5) Quản lý nhóm công việc inline.

Hệ thống sử dụng Supabase (PostgreSQL), React 18/TypeScript, shadcn/ui, TanStack React Query, React Hook Form + Zod, Tailwind CSS.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Loại_công_việc**: Bản ghi phân loại công việc vận hành/bảo trì, lưu trong bảng `job_types`
- **Nhóm_công_việc**: Nhóm phân loại các Loại_công_việc (VD: Điện, Nước, Cơ khí), lưu trong bảng `job_groups`
- **Bộ_phận**: Bộ phận/phòng ban chịu trách nhiệm thực hiện công việc, lưu trong bảng `departments`
- **Mức_độ_ưu_tiên**: Mức ưu tiên của Loại_công_việc, sử dụng enum `issue_priority` gồm: URGENT (Khẩn cấp), HIGH (Cao), MEDIUM (Trung bình), LOW (Thấp)
- **Deadline_liên_hệ_KH**: Thời gian tối đa (phút) để liên hệ khách hàng sau khi nhận công việc, cột `customer_contact_deadline`
- **Deadline_tiếp_nhận**: Thời gian tối đa (phút) để bộ phận tiếp nhận công việc, cột `acceptance_deadline`
- **Deadline_hoàn_thành**: Thời gian tối đa (phút) để hoàn thành công việc, cột `completion_deadline`
- **Tính_giờ_hành_chính**: Cờ boolean xác định deadline tính theo giờ hành chính (9h-18h) hay 24/7, cột `business_hours_only`
- **Trang_loại_công_việc**: Trang quản lý Loại công việc tại Cài đặt hệ thống > Danh mục khác > Loại công việc

## Yêu cầu

### Yêu cầu 1: Hiển thị danh sách Loại công việc

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả Loại công việc đã tạo, để quản lý và theo dõi các loại công việc trong hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập đường dẫn Cài đặt hệ thống > Danh mục khác > Loại công việc, THE Hệ_thống SHALL hiển thị Trang_loại_công_việc với breadcrumb "Cài đặt hệ thống > Danh mục khác > Loại công việc"
2. THE Hệ_thống SHALL hiển thị bảng danh sách Loại_công_việc với các cột: Tên loại công việc (name), Nhóm công việc (job_group tên), Mức độ ưu tiên (default_priority), Deadline liên hệ KH (customer_contact_deadline, hiển thị phút), Deadline tiếp nhận (acceptance_deadline, hiển thị phút), Deadline hoàn thành (completion_deadline, hiển thị phút), Tính giờ hành chính (business_hours_only, hiển thị Có/Không), Bộ phận thực hiện (department tên), Thao tác (nút Sửa, Xoá)
3. THE Hệ_thống SHALL sắp xếp danh sách theo created_at giảm dần (loại mới nhất hiển thị trước)
4. THE Hệ_thống SHALL chỉ hiển thị Loại_công_việc thuộc Người_dùng hiện tại (RLS policy: auth.uid() = user_id)
5. WHILE danh sách Loại_công_việc rỗng, THE Hệ_thống SHALL hiển thị trạng thái trống với thông báo hướng dẫn thêm mới

### Yêu cầu 2: Thêm mới Loại công việc

**User Story:** Là một Người_dùng, tôi muốn thêm mới Loại công việc với đầy đủ thông tin deadline và phân công bộ phận, để hệ thống tự động phân công và theo dõi tiến độ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút (+) Thêm loại công việc tại Trang_loại_công_việc, THE Hệ_thống SHALL hiển thị dialog form thêm mới với các trường: Tên loại công việc (*), Nhóm công việc (dropdown chọn từ danh sách Nhóm_công_việc hoặc thêm mới), Mức độ ưu tiên (dropdown: Khẩn cấp/Cao/Trung bình/Thấp, mặc định Trung bình), Deadline liên hệ KH (số phút, mặc định 0), Deadline tiếp nhận công việc (số phút, mặc định 0), Deadline hoàn thành công việc (số phút, mặc định 0), Tính giờ hành chính (toggle switch, mặc định tắt), Bộ phận thực hiện (dropdown chọn từ danh sách Bộ_phận)
2. THE Hệ_thống SHALL đánh dấu trường bắt buộc bằng ký hiệu (*) gồm: Tên loại công việc, Nhóm công việc, Bộ phận thực hiện
3. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Loại_công_việc mới trong bảng `job_types` và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
4. IF Người_dùng không điền Tên loại công việc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation "Tên loại công việc không được để trống"
5. WHEN Loại_công_việc được tạo thành công, THE Hệ_thống SHALL đóng dialog form và cập nhật danh sách hiển thị bản ghi mới
6. THE Hệ_thống SHALL hiển thị giá trị 0 cho các trường deadline với ghi chú "0 = không áp dụng"

### Yêu cầu 3: Quản lý Nhóm công việc inline

**User Story:** Là một Người_dùng, tôi muốn thêm mới Nhóm công việc ngay trong form thêm/sửa Loại công việc, để không phải chuyển sang trang khác khi nhóm chưa có sẵn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị dropdown Nhóm công việc trong form Loại_công_việc với danh sách Nhóm_công_việc hiện có của Người_dùng
2. WHEN Nhóm_công_việc cần thiết không có sẵn trong danh sách, THE Hệ_thống SHALL hiển thị tuỳ chọn "Thêm nhóm mới" trong dropdown cho phép Người_dùng nhập tên nhóm mới
3. WHEN Người_dùng chọn "Thêm nhóm mới" và nhập tên nhóm, THE Hệ_thống SHALL tạo Nhóm_công_việc mới trong bảng `job_groups` và tự động chọn nhóm vừa tạo trong dropdown
4. THE Hệ_thống SHALL chỉ hiển thị Nhóm_công_việc thuộc Người_dùng hiện tại (RLS policy: auth.uid() = user_id)

### Yêu cầu 4: Sửa Loại công việc

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin Loại công việc đã tạo, để cập nhật khi có thay đổi về deadline hoặc phân công bộ phận.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Sửa tại cột Thao tác của một Loại_công_việc, THE Hệ_thống SHALL hiển thị dialog form chỉnh sửa với đầy đủ thông tin hiện tại bao gồm: Tên loại công việc, Nhóm công việc, Mức độ ưu tiên, Deadline liên hệ KH, Deadline tiếp nhận, Deadline hoàn thành, Tính giờ hành chính, Bộ phận thực hiện
2. THE Hệ_thống SHALL cho phép chỉnh sửa tất cả các trường của Loại_công_việc
3. WHEN Người_dùng lưu thay đổi, THE Hệ_thống SHALL cập nhật Loại_công_việc trong bảng `job_types` và hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
4. IF Người_dùng xoá Tên loại công việc (để trống), THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation "Tên loại công việc không được để trống"
5. WHEN cập nhật thành công, THE Hệ_thống SHALL đóng dialog form và cập nhật danh sách hiển thị thông tin mới

### Yêu cầu 5: Xoá Loại công việc

**User Story:** Là một Người_dùng, tôi muốn xoá Loại công việc không còn sử dụng, để giữ danh sách gọn gàng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Xoá tại cột Thao tác của một Loại_công_việc, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá với nội dung "Bạn có chắc chắn muốn xoá loại công việc này không?"
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL xoá Loại_công_việc khỏi bảng `job_types` và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. WHEN Người_dùng huỷ xoá, THE Hệ_thống SHALL đóng hộp thoại xác nhận và giữ nguyên dữ liệu
4. WHEN xoá thành công, THE Hệ_thống SHALL cập nhật danh sách loại bỏ bản ghi đã xoá

### Yêu cầu 6: Validation dữ liệu Loại công việc

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate dữ liệu đầu vào chính xác, để đảm bảo tính toàn vẹn dữ liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate Tên loại công việc (name) không rỗng và có ít nhất 1 ký tự khi tạo hoặc cập nhật Loại_công_việc
2. THE Hệ_thống SHALL validate Mức độ ưu tiên (default_priority) phải là một trong các giá trị: URGENT, HIGH, MEDIUM, LOW
3. THE Hệ_thống SHALL validate Deadline liên hệ KH (customer_contact_deadline) là số nguyên không âm (>= 0)
4. THE Hệ_thống SHALL validate Deadline tiếp nhận (acceptance_deadline) là số nguyên không âm (>= 0)
5. THE Hệ_thống SHALL validate Deadline hoàn thành (completion_deadline) là số nguyên không âm (>= 0)
6. THE Hệ_thống SHALL validate Tính giờ hành chính (business_hours_only) là giá trị boolean
7. FOR ALL đối tượng Loại_công_việc input hợp lệ, Zod schema validation SHALL chấp nhận và parse thành công (round-trip property)
8. FOR ALL đối tượng Loại_công_việc input thiếu trường bắt buộc hoặc có giá trị không hợp lệ, Zod schema validation SHALL từ chối và trả về lỗi tương ứng

### Yêu cầu 7: Database Schema và RLS

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn với RLS policies, để đảm bảo dữ liệu an toàn và chỉ truy cập được dữ liệu của mình.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL sử dụng bảng `job_types` hiện có với các cột: id (UUID PK), user_id (FK auth.users), name (TEXT NOT NULL), job_group_id (FK job_groups nullable), description (TEXT nullable), default_priority (issue_priority DEFAULT 'MEDIUM'), customer_contact_deadline (INTEGER DEFAULT 0, CHECK >= 0), acceptance_deadline (INTEGER DEFAULT 0, CHECK >= 0), completion_deadline (INTEGER DEFAULT 0, CHECK >= 0), business_hours_only (BOOLEAN DEFAULT false), default_department_id (FK departments nullable), auto_assign (BOOLEAN DEFAULT false), is_active (BOOLEAN DEFAULT true), created_at, updated_at
2. THE Hệ_thống SHALL sử dụng bảng `job_groups` hiện có với các cột: id (UUID PK), user_id (FK auth.users), name (TEXT NOT NULL), description (TEXT nullable), color (TEXT nullable), icon (TEXT nullable), created_at, updated_at
3. THE Hệ_thống SHALL sử dụng bảng `departments` hiện có với các cột: id (UUID PK), user_id (FK auth.users), code (TEXT NOT NULL), name (TEXT NOT NULL), description (TEXT nullable), is_active (BOOLEAN DEFAULT true), created_at, updated_at
4. THE Hệ_thống SHALL có RLS policies trên bảng `job_types` đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (auth.uid() = user_id)
5. THE Hệ_thống SHALL có RLS policies trên bảng `job_groups` đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (auth.uid() = user_id)
6. THE Hệ_thống SHALL có RLS policies trên bảng `departments` đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (auth.uid() = user_id)

### Yêu cầu 8: Tích hợp Navigation và Routing

**User Story:** Là một Người_dùng, tôi muốn truy cập trang Loại công việc từ menu Danh mục khác, để dễ dàng tìm và quản lý.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL đăng ký route `/settings/categories/task-types` trỏ đến trang Loại công việc
2. THE Hệ_thống SHALL hiển thị mục "Loại công việc" trong trang Danh mục khác (CategoriesPage) dưới nhóm phù hợp với mô tả "Quản lý loại công việc vận hành"
3. WHEN Người_dùng click vào mục "Loại công việc" tại trang Danh mục khác, THE Hệ_thống SHALL điều hướng đến route `/settings/categories/task-types`
4. THE Hệ_thống SHALL hiển thị trang Loại công việc trong MainLayout với breadcrumb chính xác
