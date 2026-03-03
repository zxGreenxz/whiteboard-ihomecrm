# Tài liệu Yêu cầu - Quản lý Công việc (Task Management)

## Giới thiệu

Trang Công việc trong phần mềm quản lý Bất động sản Resident cho phép chủ nhà và nhân viên quản lý tạo, theo dõi, và xử lý các công việc liên quan đến vận hành căn hộ/dự án. Mỗi bộ phận có các công việc khác nhau cần xử lý. Hệ thống hỗ trợ quy trình công việc hoàn chỉnh từ tạo mới → nhận xử lý → hoàn thành → nghiệm thu, kèm theo thống kê và lọc công việc.

Công việc bao gồm cả công việc tự tạo VÀ công việc liên quan đến sự cố nhận từ khách thuê. Hệ thống sử dụng Supabase (PostgreSQL), React 18/TypeScript, shadcn/ui, TanStack React Query, React Hook Form + Zod, Tailwind CSS.

Cần tạo bảng `jobs` mới trong database để lưu trữ các công việc (task instances), khác với bảng `job_types` (loại công việc) đã có sẵn. Bảng `jobs` sẽ tham chiếu đến `job_types`, `job_groups`, `buildings`, `rooms`, `beds`, `profiles` (người thực hiện).

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Công_việc**: Bản ghi công việc cần thực hiện, lưu trong bảng `jobs`
- **Loại_công_việc**: Phân loại công việc, lưu trong bảng `job_types` (đã có sẵn)
- **Nhóm_công_việc**: Nhóm phân loại các Loại_công_việc, lưu trong bảng `job_groups` (đã có sẵn)
- **Người_thực_hiện**: Nhân viên được giao thực hiện Công_việc, tham chiếu bảng `profiles`
- **Mức_độ_ưu_tiên**: Mức ưu tiên của Công_việc, sử dụng enum gồm: Bình thường (NORMAL), Thấp (LOW), Gấp (URGENT)
- **Trạng_thái_công_việc**: Trạng thái hiện tại của Công_việc, gồm: Chưa làm (NOT_STARTED), Đang làm (IN_PROGRESS), Chờ nghiệm thu (PENDING_ACCEPTANCE), Đã nghiệm thu (ACCEPTED), Không đạt (FAILED), Quá hạn (OVERDUE)
- **Trang_công_việc**: Trang quản lý Công việc chính tại menu Công việc
- **Căn_hộ**: Tòa nhà/căn hộ, lưu trong bảng `buildings`
- **Phòng**: Phòng trong căn hộ, lưu trong bảng `rooms`
- **Giường**: Giường trong phòng, lưu trong bảng `beds`

## Yêu cầu

### Yêu cầu 1: Hiển thị danh sách Công việc

**User Story:** Là một Người_dùng, tôi muốn xem danh sách tất cả Công việc đã tạo, để quản lý và theo dõi tiến độ xử lý công việc.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng truy cập Trang_công_việc, THE Hệ_thống SHALL hiển thị danh sách Công_việc dưới dạng bảng với các cột: Mã công việc, Tiêu đề, Căn hộ, Phòng, Nhóm công việc, Loại công việc, Mức độ ưu tiên, Người thực hiện, Hạn hoàn thành, Trạng thái, Thao tác
2. THE Hệ_thống SHALL sắp xếp danh sách theo created_at giảm dần (công việc mới nhất hiển thị trước)
3. THE Hệ_thống SHALL chỉ hiển thị Công_việc thuộc Người_dùng hiện tại (RLS policy: auth.uid() = user_id)
4. WHILE danh sách Công_việc rỗng, THE Hệ_thống SHALL hiển thị trạng thái trống với thông báo hướng dẫn thêm mới
5. WHEN Người_dùng click vào Mã công việc của một Công_việc, THE Hệ_thống SHALL hiển thị chi tiết Công_việc đó

### Yêu cầu 2: Thống kê Công việc

**User Story:** Là một Người_dùng, tôi muốn xem thống kê tổng quan số lượng công việc theo từng trạng thái, để nắm bắt nhanh tình hình xử lý công việc.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị phần thống kê ở đầu Trang_công_việc với số lượng Công_việc theo từng Trạng_thái_công_việc: Chưa làm, Đang làm, Chờ nghiệm thu, Đã nghiệm thu, Không đạt, Quá hạn
2. THE Hệ_thống SHALL cập nhật số liệu thống kê khi danh sách Công_việc thay đổi (thêm, sửa trạng thái, xoá)
3. THE Hệ_thống SHALL hiển thị mỗi trạng thái với màu sắc phân biệt để dễ nhận diện

### Yêu cầu 3: Lọc Công việc

**User Story:** Là một Người_dùng, tôi muốn lọc danh sách công việc theo nhiều tiêu chí, để tìm nhanh các công việc cần quan tâm.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút biểu tượng lọc (3 đường ngang) ở góc phải trên, THE Hệ_thống SHALL hiển thị panel bộ lọc với các tiêu chí: Căn hộ, Phòng, Nhóm công việc, Loại công việc, Mức độ ưu tiên, Người thực hiện, Trạng thái, Khoảng thời gian
2. WHEN Người_dùng chọn tiêu chí lọc và ấn nút "Áp dụng", THE Hệ_thống SHALL lọc danh sách Công_việc theo các tiêu chí đã chọn
3. WHEN Người_dùng xoá bộ lọc, THE Hệ_thống SHALL hiển thị lại toàn bộ danh sách Công_việc
4. THE Hệ_thống SHALL cập nhật phần thống kê theo kết quả lọc

### Yêu cầu 4: Tạo mới Công việc

**User Story:** Là một Người_dùng, tôi muốn tạo công việc mới với đầy đủ thông tin, để giao việc cho nhân viên xử lý.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút (+) Thêm công việc tại Trang_công_việc, THE Hệ_thống SHALL hiển thị dialog form tạo mới với các trường: Căn hộ (dropdown chọn từ danh sách buildings), Phòng (dropdown chọn từ danh sách rooms theo căn hộ đã chọn), Giường (dropdown chọn từ danh sách beds theo phòng đã chọn), Tiêu đề (*), Mô tả (textarea), Nhóm công việc (dropdown chọn từ danh sách hoặc thêm mới bằng nút +), Loại công việc (dropdown chọn từ danh sách hoặc thêm mới bằng nút +), Mức độ ưu tiên (dropdown: Bình thường/Thấp/Gấp, mặc định Bình thường), Người thực hiện (dropdown chọn từ danh sách profiles), Hạn hoàn thành (date/time picker), Hiển thị với khách hàng (toggle on/off, mặc định off), Đính kèm (upload ảnh hoặc file)
2. THE Hệ_thống SHALL tự động tạo Mã công việc duy nhất cho mỗi Công_việc mới
3. THE Hệ_thống SHALL đặt Trạng_thái_công_việc mặc định là "Chưa làm" (NOT_STARTED) khi tạo mới
4. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Công_việc mới trong bảng `jobs` và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. IF Người_dùng không điền Tiêu đề, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation "Tiêu đề không được để trống"
6. WHEN Công_việc được tạo thành công, THE Hệ_thống SHALL đóng dialog form và cập nhật danh sách hiển thị bản ghi mới
7. WHEN Người_dùng chọn Căn hộ, THE Hệ_thống SHALL lọc danh sách Phòng theo Căn hộ đã chọn
8. WHEN Người_dùng chọn Phòng, THE Hệ_thống SHALL lọc danh sách Giường theo Phòng đã chọn

### Yêu cầu 5: Nhận xử lý Công việc

**User Story:** Là một Người_thực_hiện, tôi muốn nhận xử lý công việc được giao, để bắt đầu thực hiện công việc.

#### Tiêu chí chấp nhận

1. WHILE Công_việc có Trạng_thái_công_việc là "Chưa làm" (NOT_STARTED), THE Hệ_thống SHALL hiển thị nút "Nhận xử lý" trong chi tiết Công_việc
2. WHEN Người_dùng ấn nút "Nhận xử lý", THE Hệ_thống SHALL hiển thị hộp thoại xác nhận với nội dung "Bạn có chắc chắn muốn nhận việc?"
3. WHEN Người_dùng xác nhận nhận việc, THE Hệ_thống SHALL cập nhật Trạng_thái_công_việc thành "Đang làm" (IN_PROGRESS)
4. WHILE Công_việc có Trạng_thái_công_việc là "Đang làm" (IN_PROGRESS), THE Hệ_thống SHALL hiển thị nút "Bắt đầu làm" để thông báo cho quản lý và khách thuê rằng công việc đã bắt đầu

### Yêu cầu 6: Hoàn thành Công việc

**User Story:** Là một Người_thực_hiện, tôi muốn báo hoàn thành công việc với thông tin kết quả, để chuyển sang bước nghiệm thu.

#### Tiêu chí chấp nhận

1. WHILE Công_việc có Trạng_thái_công_việc là "Đang làm" (IN_PROGRESS), THE Hệ_thống SHALL hiển thị nút "Hoàn thành" trong chi tiết Công_việc
2. WHEN Người_dùng ấn nút "Hoàn thành", THE Hệ_thống SHALL hiển thị form hoàn thành với các trường: Thời gian hoàn thành (date/time picker), Mô tả kết quả (textarea), Đính kèm (upload ảnh hoặc file, tuỳ chọn)
3. WHEN Người_dùng điền thông tin và ấn nút "Lưu", THE Hệ_thống SHALL cập nhật Trạng_thái_công_việc thành "Chờ nghiệm thu" (PENDING_ACCEPTANCE) và lưu thông tin hoàn thành
4. IF Người_dùng không điền Thời gian hoàn thành, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation "Thời gian hoàn thành không được để trống"

### Yêu cầu 7: Nghiệm thu Công việc

**User Story:** Là một Người_dùng có quyền nghiệm thu, tôi muốn đánh giá kết quả công việc, để xác nhận công việc đã hoàn thành đạt yêu cầu.

#### Tiêu chí chấp nhận

1. WHILE Công_việc có Trạng_thái_công_việc là "Chờ nghiệm thu" (PENDING_ACCEPTANCE), THE Hệ_thống SHALL hiển thị nút "Nghiệm thu công việc" trong chi tiết Công_việc
2. WHEN Người_dùng ấn nút "Nghiệm thu công việc", THE Hệ_thống SHALL hiển thị form nghiệm thu với các trường: Đánh giá kết quả (textarea), Đánh giá khách hàng (textarea), Ý kiến khách hàng (textarea)
3. WHEN Người_dùng điền thông tin nghiệm thu và ấn nút "Lưu", THE Hệ_thống SHALL cập nhật Trạng_thái_công_việc thành "Đã nghiệm thu" (ACCEPTED) và lưu thông tin nghiệm thu
4. WHEN Người_dùng đánh giá công việc không đạt, THE Hệ_thống SHALL cập nhật Trạng_thái_công_việc thành "Không đạt" (FAILED)

### Yêu cầu 8: Luồng trạng thái Công việc

**User Story:** Là một Người_dùng, tôi muốn hệ thống kiểm soát luồng trạng thái công việc chặt chẽ, để đảm bảo quy trình xử lý đúng thứ tự.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL chỉ cho phép chuyển Trạng_thái_công_việc theo luồng: NOT_STARTED → IN_PROGRESS → PENDING_ACCEPTANCE → ACCEPTED hoặc FAILED
2. THE Hệ_thống SHALL tự động đánh dấu Công_việc là "Quá hạn" (OVERDUE) khi thời gian hiện tại vượt quá Hạn hoàn thành và Trạng_thái_công_việc chưa phải ACCEPTED
3. IF Người_dùng cố gắng chuyển Trạng_thái_công_việc không theo luồng cho phép, THEN THE Hệ_thống SHALL từ chối thao tác và giữ nguyên trạng thái hiện tại
4. FOR ALL Công_việc, Trạng_thái_công_việc tại bất kỳ thời điểm nào SHALL là một trong các giá trị: NOT_STARTED, IN_PROGRESS, PENDING_ACCEPTANCE, ACCEPTED, FAILED, OVERDUE

### Yêu cầu 9: Quản lý Nhóm công việc và Loại công việc inline

**User Story:** Là một Người_dùng, tôi muốn thêm mới Nhóm công việc và Loại công việc ngay trong form tạo công việc, để không phải chuyển sang trang khác.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị dropdown Nhóm công việc trong form Công_việc với danh sách Nhóm_công_việc hiện có và nút (+) để thêm mới
2. WHEN Người_dùng ấn nút (+) bên cạnh dropdown Nhóm công việc, THE Hệ_thống SHALL hiển thị input cho phép nhập tên nhóm mới và tạo Nhóm_công_việc mới trong bảng `job_groups`
3. THE Hệ_thống SHALL hiển thị dropdown Loại công việc trong form Công_việc với danh sách Loại_công_việc hiện có và nút (+) để thêm mới
4. WHEN Người_dùng ấn nút (+) bên cạnh dropdown Loại công việc, THE Hệ_thống SHALL hiển thị input cho phép nhập tên loại mới và tạo Loại_công_việc mới trong bảng `job_types`

### Yêu cầu 10: Đính kèm tệp tin

**User Story:** Là một Người_dùng, tôi muốn đính kèm ảnh hoặc tệp tin vào công việc, để cung cấp thông tin bổ sung cho người thực hiện.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL cho phép Người_dùng upload ảnh hoặc tệp tin khi tạo mới Công_việc
2. THE Hệ_thống SHALL cho phép Người_dùng upload ảnh hoặc tệp tin khi hoàn thành Công_việc
3. THE Hệ_thống SHALL lưu trữ tệp đính kèm trên Supabase Storage và lưu URL tham chiếu trong bản ghi Công_việc
4. THE Hệ_thống SHALL hiển thị danh sách tệp đính kèm trong chi tiết Công_việc

### Yêu cầu 11: Validation dữ liệu Công việc

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate dữ liệu đầu vào chính xác, để đảm bảo tính toàn vẹn dữ liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate Tiêu đề (title) không rỗng và có ít nhất 1 ký tự khi tạo Công_việc
2. THE Hệ_thống SHALL validate Mức_độ_ưu_tiên phải là một trong các giá trị: NORMAL, LOW, URGENT
3. THE Hệ_thống SHALL validate Hạn hoàn thành (deadline) là ngày giờ hợp lệ khi được cung cấp
4. THE Hệ_thống SHALL validate Trạng_thái_công_việc phải là một trong các giá trị: NOT_STARTED, IN_PROGRESS, PENDING_ACCEPTANCE, ACCEPTED, FAILED, OVERDUE
5. FOR ALL đối tượng Công_việc input hợp lệ, Zod schema validation SHALL chấp nhận và parse thành công (round-trip property)
6. FOR ALL đối tượng Công_việc input thiếu trường bắt buộc hoặc có giá trị không hợp lệ, Zod schema validation SHALL từ chối và trả về lỗi tương ứng

### Yêu cầu 12: Database Schema cho bảng jobs

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn với RLS policies, để đảm bảo dữ liệu an toàn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL sử dụng bảng `jobs` mới với các cột: id (UUID PK), user_id (FK auth.users), code (TEXT UNIQUE NOT NULL, mã công việc tự sinh), title (TEXT NOT NULL), description (TEXT nullable), building_id (FK buildings nullable), room_id (FK rooms nullable), bed_id (FK beds nullable), job_group_id (FK job_groups nullable), job_type_id (FK job_types nullable), priority (TEXT NOT NULL DEFAULT 'NORMAL', CHECK IN ('NORMAL', 'LOW', 'URGENT')), assignee_id (FK profiles nullable), deadline (TIMESTAMPTZ nullable), status (TEXT NOT NULL DEFAULT 'NOT_STARTED', CHECK IN ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'FAILED', 'OVERDUE')), visible_to_customer (BOOLEAN DEFAULT false), attachments (JSONB nullable), completion_time (TIMESTAMPTZ nullable), completion_description (TEXT nullable), completion_attachments (JSONB nullable), acceptance_result (TEXT nullable), customer_evaluation (TEXT nullable), customer_comments (TEXT nullable), accepted_at (TIMESTAMPTZ nullable), started_at (TIMESTAMPTZ nullable), created_at (TIMESTAMPTZ DEFAULT now()), updated_at (TIMESTAMPTZ DEFAULT now())
2. THE Hệ_thống SHALL có RLS policies trên bảng `jobs` đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (auth.uid() = user_id)
3. THE Hệ_thống SHALL tạo enum hoặc CHECK constraint cho priority với giá trị: NORMAL, LOW, URGENT
4. THE Hệ_thống SHALL tạo enum hoặc CHECK constraint cho status với giá trị: NOT_STARTED, IN_PROGRESS, PENDING_ACCEPTANCE, ACCEPTED, FAILED, OVERDUE

### Yêu cầu 13: Tích hợp Navigation và Routing

**User Story:** Là một Người_dùng, tôi muốn truy cập trang Công việc từ menu chính, để dễ dàng quản lý công việc.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL đăng ký route `/tasks` trỏ đến Trang_công_việc
2. THE Hệ_thống SHALL hiển thị mục "Công việc" trong menu sidebar chính
3. WHEN Người_dùng click vào mục "Công việc" tại sidebar, THE Hệ_thống SHALL điều hướng đến route `/tasks`
4. THE Hệ_thống SHALL hiển thị Trang_công_việc trong MainLayout với breadcrumb "Công việc"
