# Tài liệu Yêu cầu - Tái triển khai Thu chi (Income/Expense)

## Giới thiệu

Trong phần mềm quản lý Bất động sản Resident, màn Thu chi hỗ trợ chủ nhà quản lý tất cả các khoản thu và khoản chi tại Căn hộ bao gồm cả các khoản Thu/chi từ hoá đơn và các khoản Thu/chi phát sinh khác ngoài hoá đơn. Đối với các khoản Thu/chi phát sinh ngoài hoá đơn, Người dùng hoàn toàn có thể lập Phiếu thu/Phiếu chi để hệ thống thống kê và ghi nhận.

Module Thu chi nằm tại thanh công cụ → mục Thu chi (Quản lý & Vận hành → Tài chính → Thu chi). Module bao gồm: (1) Danh sách phiếu Thu/chi với thống kê tổng thu/tổng chi, (2) Lập phiếu thu với hạng mục chi tiết, (3) Lập phiếu chi với hạng mục chi tiết, (4) Sửa/Xoá phiếu (chỉ khi ở trạng thái Bỏ duyệt), (5) Duyệt/Bỏ duyệt phiếu, (6) Nhập hàng loạt phiếu Thu/chi từ file Excel mẫu, (7) Lọc phiếu Thu/chi theo nhiều tiêu chí, (8) Thống kê Thu chi.

Hệ thống hiện có database schema (bảng `income_expenses`, `income_expense_items`, `income_expense_types`, `income_expense_templates`) với triggers tự động sinh mã phiếu, tính thành tiền, và RPC duyệt/bỏ duyệt. Cần tái triển khai lại toàn bộ giao diện React, hooks, validation, và logic nghiệp vụ để khớp 100% với tài liệu hướng dẫn chính thức. Hệ thống sử dụng Supabase (PostgreSQL), React 18/TypeScript, shadcn/ui, TanStack React Query, React Hook Form + Zod, Tailwind CSS.

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Phiếu_thu_chi**: Bản ghi ghi nhận một khoản thu hoặc chi phát sinh, lưu trong bảng `income_expenses`
- **Phiếu_thu**: Phiếu_thu_chi có type = 'INCOME', ghi nhận khoản tiền thu vào
- **Phiếu_chi**: Phiếu_thu_chi có type = 'EXPENSE', ghi nhận khoản tiền chi ra
- **Hạng_mục**: Dòng chi tiết trong Phiếu_thu_chi, mỗi phiếu có thể có nhiều hạng mục, lưu trong bảng `income_expense_items`
- **Loại_thu_chi**: Danh mục phân loại các khoản thu chi (tiền thuê, phí dịch vụ, tiền phạt, chi phí sửa chữa...), lưu trong bảng `income_expense_types`
- **Mẫu_thu_chi**: Mẫu in biên lai thu/chi dùng để in phiếu, lưu trong bảng `income_expense_templates`
- **Trạng_thái_duyệt**: Trạng thái phê duyệt của Phiếu_thu_chi, gồm UNAPPROVED (Bỏ duyệt/Chưa duyệt) và APPROVED (Đã duyệt)
- **Căn_hộ**: Tòa nhà trong hệ thống, lưu trong bảng `buildings`
- **Phòng**: Đơn vị cho thuê thuộc Căn_hộ, lưu trong bảng `rooms`
- **Giường**: Đơn vị cho thuê nhỏ hơn thuộc Phòng (cho KTX/Sleepbox), lưu trong bảng `beds`
- **Khách_hàng**: Khách thuê trong hệ thống, lưu trong bảng `tenants`
- **Sổ_quỹ**: Module báo cáo tài chính tổng hợp thu chi theo ngày
- **Màn_thu_chi**: Màn hình chính của module Thu chi, hiển thị khi chọn mục Thu chi tại thanh công cụ
- **Mã_phiếu**: Mã tự sinh cho mỗi Phiếu_thu_chi bởi database trigger, định dạng PT{YYMM}{sequence} cho Phiếu_thu, PC{YYMM}{sequence} cho Phiếu_chi (sequence là 3 chữ số zero-padded, theo user/tháng/loại)
- **Cột_Thao_tác**: Cột cuối cùng trong bảng danh sách, chứa các nút: Cập nhật, Xoá, Duyệt/Bỏ duyệt

## Yêu cầu

### Yêu cầu 1: Hiển thị danh sách phiếu Thu/chi và thống kê

**User Story:** Là một Người_dùng, tôi muốn xem danh sách phiếu Thu/chi với thống kê tổng thu/tổng chi, để theo dõi tình hình tài chính tại các Căn hộ.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng chọn mục Thu chi tại thanh công cụ, THE Hệ_thống SHALL hiển thị Màn_thu_chi với danh sách phiếu Thu chi
2. THE Hệ_thống SHALL hiển thị phần thống kê phía trên danh sách thu chi với các thẻ: Tổng thu (tổng total_amount của tất cả Phiếu_thu khớp bộ lọc hiện tại), Tổng chi (tổng total_amount của tất cả Phiếu_chi khớp bộ lọc hiện tại), Chênh lệch (Tổng thu - Tổng chi), Tổng số phiếu
3. THE Hệ_thống SHALL hiển thị thanh công cụ với các nút: nút dấu (+) để Thêm Thu/chi, nút Thêm dữ liệu hình mũi tên đi lên để nhập từ file, nút Lọc dữ liệu (nút 3 gạch màu đen), ô Tìm kiếm
4. THE Hệ_thống SHALL hiển thị bảng danh sách Phiếu_thu_chi với các cột: Mã phiếu (code), Loại phiếu (Phiếu thu/Phiếu chi), Tên phiếu (name), Căn hộ (building_name), Phòng (room_name), Khách hàng (tenant_name), Ngày (voucher_date), Tổng tiền (total_amount), Trạng thái duyệt (approval_status), Thao tác (nút Cập nhật, Xoá, Duyệt/Bỏ duyệt)
5. THE Hệ_thống SHALL sắp xếp danh sách theo voucher_date giảm dần (phiếu mới nhất hiển thị trước)
6. THE Hệ_thống SHALL hỗ trợ phân trang với số lượng phiếu mỗi trang có thể cấu hình (mặc định 20)
7. THE Hệ_thống SHALL hiển thị ô tìm kiếm cho phép tìm theo tên phiếu, mã phiếu, hoặc tên khách hàng

### Yêu cầu 2: Lập Phiếu thu

**User Story:** Là một Người_dùng, tôi muốn lập Phiếu thu để ghi nhận các khoản tiền thu vào tại Căn hộ, bao gồm cả các khoản thu phát sinh ngoài hoá đơn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút dấu (+) tại Màn_thu_chi, THE Hệ_thống SHALL hiển thị màn chi tiết Thêm phiếu thu/chi với hai lựa chọn loại phiếu: Phiếu thu và Phiếu chi
2. WHEN Người_dùng ấn chọn ô Phiếu thu, THE Hệ_thống SHALL hiển thị form với các trường: Căn hộ (*), Phòng, Giường, Khách hàng, Tên phiếu thu (*), Ngày thu (*), Ghi chú
3. THE Hệ_thống SHALL đánh dấu các trường bắt buộc bằng ký hiệu (*) gồm: Căn hộ, Tên phiếu thu, Ngày thu
4. WHEN Người_dùng chọn Căn hộ, THE Hệ_thống SHALL tải và hiển thị danh sách Phòng thuộc Căn hộ đã chọn trong dropdown Phòng
5. WHEN Người_dùng chọn Phòng, THE Hệ_thống SHALL tải và hiển thị danh sách Giường thuộc Phòng đã chọn trong dropdown Giường
6. WHEN Người_dùng ấn nút (+) tại phần Thêm hạng mục, THE Hệ_thống SHALL hiển thị màn hình chi tiết chọn hạng mục với danh sách Loại_thu_chi có sẵn (checkbox cho mỗi loại) để Người_dùng tích chọn hạng mục phù hợp
7. WHEN hạng mục không có sẵn trong danh sách, THE Hệ_thống SHALL hiển thị nút Thêm để Người_dùng thêm hạng mục mới
8. WHEN Người_dùng tích chọn một hoặc nhiều Hạng_mục và xác nhận, THE Hệ_thống SHALL hiển thị thông tin các Hạng_mục đã chọn ra màn hình Chi tiết Thu/chi với các trường cho mỗi hạng mục: Tên loại (readonly), Mô tả, Số lượng (mặc định 1), Đơn giá, Thành tiền (tự tính = Số lượng × Đơn giá)
9. THE Hệ_thống SHALL cho phép Người_dùng điền thông tin còn lại của hạng mục (Mô tả, Số lượng, Đơn giá) trước khi ấn Lưu
10. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Phiếu_thu mới với Trạng_thái_duyệt là UNAPPROVED, database trigger tự động sinh Mã_phiếu định dạng PT{YYMM}{sequence}, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
11. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường bị thiếu
12. IF Người_dùng không thêm ít nhất 1 Hạng_mục, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Vui lòng thêm ít nhất 1 hạng mục"

### Yêu cầu 3: Lập Phiếu chi

**User Story:** Là một Người_dùng, tôi muốn lập Phiếu chi để ghi nhận các khoản tiền chi ra tại Căn hộ, bao gồm chi phí sửa chữa, bảo trì, và các khoản chi phát sinh khác.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng chọn ô Phiếu chi tại màn chi tiết Thêm phiếu thu/chi, THE Hệ_thống SHALL hiển thị form với các trường: Căn hộ (*), Phòng, Giường, Khách hàng, Tên phiếu chi (*), Ngày chi (*), Hạng mục chi, Ghi chú
2. THE Hệ_thống SHALL đánh dấu các trường bắt buộc bằng ký hiệu (*) gồm: Căn hộ, Tên phiếu chi, Ngày chi
3. THE Hệ_thống SHALL cho phép thêm nhiều Hạng_mục cho một Phiếu_chi, quy trình thêm hạng mục tương tự như Phiếu_thu (ấn nút (+) Thêm hạng mục, tích chọn hạng mục, điền thông tin chi tiết)
4. WHEN Người_dùng điền đầy đủ thông tin bắt buộc và ấn nút Lưu, THE Hệ_thống SHALL tạo Phiếu_chi mới với Trạng_thái_duyệt là UNAPPROVED, database trigger tự động sinh Mã_phiếu định dạng PC{YYMM}{sequence}, và hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. IF Người_dùng không điền đầy đủ các trường bắt buộc, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi validation tương ứng cho từng trường bị thiếu

### Yêu cầu 4: Sửa Phiếu thu/chi

**User Story:** Là một Người_dùng, tôi muốn sửa thông tin phiếu thu/chi đã tạo, để cập nhật thông tin chính xác khi có thay đổi.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click nút Cập nhật trong cột Thao tác của một Phiếu_thu_chi có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL hiển thị form chỉnh sửa với đầy đủ thông tin hiện tại bao gồm loại phiếu, Căn hộ, Phòng, Giường, Khách hàng, Tên phiếu, Ngày, Ghi chú, và danh sách Hạng_mục
2. THE Hệ_thống SHALL cho phép chỉnh sửa tất cả các trường ngoại trừ Mã_phiếu (code) và ngày tạo
3. THE Hệ_thống SHALL cho phép thêm, sửa, hoặc xoá Hạng_mục trong phiếu đang chỉnh sửa
4. WHEN Người_dùng lưu thay đổi, THE Hệ_thống SHALL cập nhật Phiếu_thu_chi và các Hạng_mục tương ứng, hiển thị thông báo "Dữ liệu đã được CẬP NHẬT thành công"
5. WHILE Phiếu_thu_chi có Trạng_thái_duyệt là APPROVED, THE Hệ_thống SHALL vô hiệu hoá nút Cập nhật cho phiếu đó
6. IF Người_dùng muốn sửa phiếu đã duyệt, THEN THE Hệ_thống SHALL yêu cầu bỏ duyệt trước khi cho phép chỉnh sửa (Người_dùng cần bỏ duyệt trước)

### Yêu cầu 5: Xoá Phiếu thu/chi

**User Story:** Là một Người_dùng, tôi muốn xoá phiếu thu/chi không cần thiết, để giữ danh sách gọn gàng.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click nút Xoá trong cột Thao tác của một Phiếu_thu_chi có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL hiển thị hộp thoại xác nhận xoá
2. WHEN Người_dùng xác nhận xoá, THE Hệ_thống SHALL thực hiện soft-delete Phiếu_thu_chi (cập nhật deleted_at) và hiển thị thông báo "Dữ liệu đã được XOÁ thành công"
3. WHILE Phiếu_thu_chi có Trạng_thái_duyệt là APPROVED, THE Hệ_thống SHALL vô hiệu hoá nút Xoá cho phiếu đó
4. IF Người_dùng muốn xoá phiếu đã duyệt, THEN THE Hệ_thống SHALL yêu cầu bỏ duyệt trước khi cho phép xoá (Người_dùng cần bỏ duyệt trước)

### Yêu cầu 6: Duyệt và Bỏ duyệt Phiếu thu/chi

**User Story:** Là một Người_dùng, tôi muốn duyệt hoặc bỏ duyệt phiếu thu/chi, để kiểm soát tính chính xác của các khoản thu chi trước khi ghi nhận chính thức.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Duyệt tại cột Thao tác của một Phiếu_thu_chi có Trạng_thái_duyệt là UNAPPROVED, THE Hệ_thống SHALL gọi RPC approve_voucher để cập nhật approval_status thành APPROVED, ghi nhận approved_by và approved_at, và hiển thị thông báo "Phiếu đã được DUYỆT thành công"
2. WHEN Người_dùng ấn nút Bỏ duyệt tại cột Thao tác của một Phiếu_thu_chi có Trạng_thái_duyệt là APPROVED, THE Hệ_thống SHALL gọi RPC unapprove_voucher để cập nhật approval_status thành UNAPPROVED, xoá approved_by và approved_at, và hiển thị thông báo "Phiếu đã được BỎ DUYỆT thành công"
3. THE Hệ_thống SHALL hiển thị trạng thái duyệt bằng badge màu: APPROVED (màu xanh, text "Đã duyệt"), UNAPPROVED (màu cam/vàng, text "Chưa duyệt")

### Yêu cầu 7: Lọc Phiếu thu/chi

**User Story:** Là một Người_dùng, tôi muốn lọc phiếu thu/chi theo nhiều tiêu chí, để tìm kiếm thông tin nhanh và xem các chỉ số liên quan.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng click nút Lọc dữ liệu (nút 3 gạch màu đen), THE Hệ_thống SHALL hiển thị thanh bộ lọc với các tiêu chí: Căn hộ (dropdown danh sách Căn_hộ), Phòng (dropdown lọc theo Căn hộ đã chọn), Sổ quỹ (dropdown), Loại phiếu (dropdown: Tất cả, Phiếu thu, Phiếu chi), Thời gian (date range picker: Từ ngày - Đến ngày), Trạng thái duyệt (dropdown: Tất cả, Đã duyệt, Chưa duyệt)
2. WHEN Người_dùng chọn Căn hộ trong bộ lọc, THE Hệ_thống SHALL cập nhật dropdown Phòng để chỉ hiển thị Phòng thuộc Căn hộ đã chọn
3. WHEN Người_dùng chọn các tiêu chí lọc và ấn nút Áp dụng, THE Hệ_thống SHALL cập nhật danh sách Phiếu_thu_chi và số liệu thống kê (Tổng thu, Tổng chi, Chênh lệch) theo bộ lọc đã chọn
4. WHEN Người_dùng xoá tất cả bộ lọc, THE Hệ_thống SHALL hiển thị lại toàn bộ danh sách Phiếu_thu_chi và thống kê tổng

### Yêu cầu 8: Thống kê Thu chi

**User Story:** Là một Người_dùng, tôi muốn xem tổng số tiền đã thu và đã chi tại Căn hộ theo: Căn hộ, Phòng, Sổ quỹ, Loại phiếu, Thời gian, để nắm bắt tình hình tài chính tổng quan.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị phần thống kê phía trên danh sách Thu chi với: Tổng thu (tổng total_amount của tất cả Phiếu_thu khớp bộ lọc, hiển thị màu xanh), Tổng chi (tổng total_amount của tất cả Phiếu_chi khớp bộ lọc, hiển thị màu đỏ), Chênh lệch (Tổng thu - Tổng chi)
2. WHEN Người_dùng thay đổi bộ lọc (Căn hộ, Phòng, Sổ quỹ, Loại phiếu, Thời gian, Trạng thái duyệt), THE Hệ_thống SHALL cập nhật lại số liệu thống kê tương ứng với bộ lọc mới
3. THE Hệ_thống SHALL hiển thị số tiền theo định dạng tiền tệ Việt Nam (VND, phân cách hàng nghìn bằng dấu chấm)

### Yêu cầu 9: Nhập hàng loạt Phiếu thu/chi từ file mẫu

**User Story:** Là một Người_dùng, tôi muốn lập nhiều phiếu Thu/chi từ file mẫu, để tạo dữ liệu nhanh khi có số lượng phiếu lớn.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thêm dữ liệu hình mũi tên đi lên tại Màn_thu_chi, THE Hệ_thống SHALL hiển thị chi tiết màn nhập dữ liệu (dialog nhập dữ liệu)
2. THE Hệ_thống SHALL hiển thị link "Tải file mẫu tại đây" trong dialog nhập dữ liệu để Người_dùng tải file mẫu
3. WHEN Người_dùng click "Tải file mẫu tại đây", THE Hệ_thống SHALL tải xuống file Excel mẫu với các cột bao gồm thông tin có sẵn và các trường cần điền, trong đó mục (*) là bắt buộc: Loại phiếu (*), Căn hộ (*), Phòng, Tên phiếu (*), Ngày (*), Hạng mục (*), Số tiền (*)
4. THE Hệ_thống SHALL hỗ trợ đẩy file lên bằng cách ấn nút "Chọn file" hoặc "Kéo thả file" vào vùng upload, chấp nhận file .xlsx và .xls
5. WHEN Người_dùng upload file hợp lệ và ấn nút "Nhập dữ liệu", THE Hệ_thống SHALL parse từng dòng, validate các trường bắt buộc, tạo Phiếu_thu_chi cho các dòng hợp lệ, và báo cáo kết quả
6. WHEN nhập dữ liệu thành công, THE Hệ_thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công" và dữ liệu mới xuất hiện trong danh sách Thu chi
7. IF một dòng trong file Excel thiếu trường bắt buộc hoặc dữ liệu không hợp lệ, THEN THE Hệ_thống SHALL bỏ qua dòng đó và bao gồm chi tiết lỗi trong báo cáo kết quả nhập

### Yêu cầu 10: Quản lý Loại thu chi (Hạng mục)

**User Story:** Là một Người_dùng, tôi muốn quản lý danh mục Loại thu chi, để phân loại các khoản thu chi một cách có hệ thống.

#### Tiêu chí chấp nhận

1. WHEN Người_dùng ấn nút Thêm trong màn hình chi tiết chọn hạng mục (khi hạng mục không có sẵn), THE Hệ_thống SHALL hiển thị form tạo Loại_thu_chi mới với các trường: Tên loại (*), Loại (thu/chi), Mô tả
2. WHEN Người_dùng lưu Loại_thu_chi mới, THE Hệ_thống SHALL tạo bản ghi mới trong bảng income_expense_types và tự động thêm vào danh sách chọn Hạng_mục
3. THE Hệ_thống SHALL hiển thị danh sách Loại_thu_chi trong màn hình chi tiết chọn hạng mục dưới dạng checkbox, cho phép tích chọn nhiều loại cùng lúc
4. THE Hệ_thống SHALL lọc danh sách Loại_thu_chi theo loại phiếu đang tạo (chỉ hiển thị loại 'income' khi tạo Phiếu_thu, chỉ hiển thị loại 'expense' khi tạo Phiếu_chi)

### Yêu cầu 11: Database Schema và Triggers

**User Story:** Là một Người_dùng, tôi muốn hệ thống có database schema đúng chuẩn với triggers tự động, để đảm bảo dữ liệu chính xác và toàn vẹn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL có bảng `income_expenses` với các cột: id (UUID PK), user_id (FK auth.users), code (TEXT, auto-generated), type (TEXT, CHECK IN 'INCOME'/'EXPENSE'), name (TEXT NOT NULL), building_id (FK buildings NOT NULL), room_id (FK rooms nullable), bed_id (FK beds nullable), tenant_id (FK tenants nullable), voucher_date (DATE NOT NULL), total_amount (DECIMAL(15,2) DEFAULT 0), approval_status (TEXT DEFAULT 'UNAPPROVED', CHECK IN 'UNAPPROVED'/'APPROVED'), approved_by (FK auth.users nullable), approved_at (TIMESTAMPTZ nullable), notes (TEXT nullable), created_at, updated_at, deleted_at
2. THE Hệ_thống SHALL có bảng `income_expense_items` với các cột: id (UUID PK), income_expense_id (FK income_expenses ON DELETE CASCADE), income_expense_type_id (FK income_expense_types ON DELETE RESTRICT), description (TEXT nullable), quantity (INTEGER NOT NULL DEFAULT 1, CHECK > 0), unit_price (DECIMAL(15,2) NOT NULL DEFAULT 0, CHECK >= 0), amount (DECIMAL(15,2), auto-calculated), notes (TEXT nullable), created_at
3. THE Hệ_thống SHALL có bảng `income_expense_types` với các cột: id (UUID PK), name (TEXT NOT NULL), type (TEXT CHECK IN 'income'/'expense'), description (TEXT nullable), is_default (BOOLEAN DEFAULT false), user_id (FK auth.users), created_at, updated_at
4. THE Hệ_thống SHALL có trigger auto_generate_voucher_code tự động sinh Mã_phiếu khi INSERT vào income_expenses: PT{YYMM}{3-digit seq} cho INCOME, PC{YYMM}{3-digit seq} cho EXPENSE
5. THE Hệ_thống SHALL có trigger auto_calc_item_amount tự động tính amount = quantity × unit_price khi INSERT/UPDATE income_expense_items
6. THE Hệ_thống SHALL có trigger auto_recalc_total_amount tự động cập nhật income_expenses.total_amount = SUM(items.amount) khi INSERT/UPDATE/DELETE income_expense_items
7. THE Hệ_thống SHALL có RLS policies trên tất cả bảng income_expense đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình (auth.uid() = user_id)
8. FOR ALL Phiếu_thu_chi hợp lệ, total_amount SHALL luôn bằng tổng amount của tất cả Hạng_mục thuộc phiếu đó (invariant property)
9. FOR ALL Hạng_mục, amount SHALL luôn bằng quantity × unit_price (invariant property)

### Yêu cầu 12: Validation dữ liệu Phiếu thu/chi

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate dữ liệu đầu vào chính xác, để đảm bảo tính toàn vẹn dữ liệu và tránh lỗi.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate loại phiếu (type) phải là 'INCOME' hoặc 'EXPENSE' khi tạo hoặc cập nhật Phiếu_thu_chi
2. THE Hệ_thống SHALL validate Tên phiếu (name) không rỗng khi tạo hoặc cập nhật Phiếu_thu_chi
3. THE Hệ_thống SHALL validate Căn hộ (building_id) không rỗng khi tạo hoặc cập nhật Phiếu_thu_chi
4. THE Hệ_thống SHALL validate Ngày (voucher_date) không rỗng khi tạo hoặc cập nhật Phiếu_thu_chi
5. THE Hệ_thống SHALL validate danh sách Hạng_mục có ít nhất 1 phần tử khi tạo hoặc cập nhật Phiếu_thu_chi
6. THE Hệ_thống SHALL validate Số lượng (quantity) của mỗi Hạng_mục là số nguyên dương (>= 1)
7. THE Hệ_thống SHALL validate Đơn giá (unit_price) của mỗi Hạng_mục là số không âm (>= 0)
8. THE Hệ_thống SHALL validate mỗi Hạng_mục phải có income_expense_type_id hợp lệ (không rỗng)
9. THE Hệ_thống SHALL chỉ cho phép sửa hoặc xoá Phiếu_thu_chi khi Trạng_thái_duyệt là UNAPPROVED
10. FOR ALL đối tượng Phiếu_thu_chi input hợp lệ, Zod schema validation SHALL chấp nhận và parse thành công (round-trip property)
11. FOR ALL đối tượng Phiếu_thu_chi input thiếu trường bắt buộc, Zod schema validation SHALL từ chối và trả về lỗi tương ứng

### Yêu cầu 13: Cascading Dropdown cho Căn hộ, Phòng, Giường

**User Story:** Là một Người_dùng, tôi muốn chọn Căn hộ, Phòng, Giường qua dropdown liên tầng, để nhập thông tin nhanh và chính xác.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị dropdown Căn hộ với danh sách Căn_hộ đang hoạt động của Người_dùng
2. WHEN Người_dùng chọn Căn hộ, THE Hệ_thống SHALL tải và hiển thị danh sách Phòng thuộc Căn hộ đã chọn trong dropdown Phòng
3. WHEN Người_dùng chọn Phòng, THE Hệ_thống SHALL tải và hiển thị danh sách Giường thuộc Phòng đã chọn trong dropdown Giường
4. WHEN Người_dùng thay đổi Căn hộ, THE Hệ_thống SHALL reset giá trị Phòng và Giường về trống
5. WHEN Người_dùng thay đổi Phòng, THE Hệ_thống SHALL reset giá trị Giường về trống
6. THE Hệ_thống SHALL hiển thị dropdown Khách hàng cho phép tìm kiếm và chọn Khách_hàng từ danh sách tenants