# Tài liệu Yêu cầu - Căn chỉnh UI Thu chi theo ảnh tham chiếu

## Giới thiệu

Module Thu chi (Income/Expense) đã được triển khai trong hệ thống quản lý bất động sản Resident. Tuy nhiên, giao diện hiện tại chưa khớp 100% với thiết kế tham chiếu (screenshots). Tài liệu này mô tả các yêu cầu thay đổi UI và bổ sung tính năng còn thiếu để giao diện danh sách Thu chi và form tạo/sửa Phiếu thu chi khớp hoàn toàn với ảnh tham chiếu.

Các thay đổi chính bao gồm:
1. Cột Thao tác chuyển từ dropdown menu sang các nút icon riêng biệt (Duyệt/Bỏ duyệt, Chỉnh sửa, Xóa)
2. Bổ sung cột Người nhận/trả và Tài khoản trong bảng danh sách
3. Bổ sung bộ lọc Khu vực, Giường, Tài khoản
4. Form tạo phiếu: chuyển từ radio button sang tab toggle (Phiếu thu / Phiếu chi)
5. Form tạo phiếu: bổ sung trường Hợp đồng, Tên người nộp, Tài khoản
6. Hạng mục: bổ sung Ngày bắt đầu, Ngày kết thúc (mặc định ngày hiện tại) cho hạch toán nhiều kỳ
7. Bổ sung toggle "Hạch toán kết quả kinh doanh?"
8. Bổ sung section Đính kèm (upload ảnh phiếu thu chi)
9. Thẻ thống kê: chuyển từ 4 thẻ sang 3 thẻ (Tổng Thu, Tổng Chi, Thu - Chi)
10. Cập nhật thứ tự cột bảng theo ảnh tham chiếu

## Thuật ngữ

- **Hệ_thống**: Ứng dụng web quản lý bất động sản Resident (React + Supabase)
- **Người_dùng**: Chủ nhà hoặc nhân viên quản lý đăng nhập vào Hệ_thống
- **Phiếu_thu_chi**: Bản ghi ghi nhận một khoản thu hoặc chi, lưu trong bảng `income_expenses`
- **Hạng_mục**: Dòng chi tiết trong Phiếu_thu_chi, lưu trong bảng `income_expense_items`
- **Cột_Thao_tác**: Cột trong bảng danh sách chứa các nút hành động dạng icon riêng biệt
- **Nút_Duyệt**: Nút icon checkmark màu xanh, dùng để duyệt phiếu (UNAPPROVED → APPROVED)
- **Nút_Bỏ_Duyệt**: Nút icon X màu cam, dùng để bỏ duyệt phiếu (APPROVED → UNAPPROVED)
- **Nút_Chỉnh_Sửa**: Nút icon bút chì màu xanh dương, dùng để mở form chỉnh sửa phiếu
- **Nút_Xóa**: Nút icon thùng rác màu đỏ, dùng để xóa phiếu
- **Tab_Toggle**: Thanh chuyển đổi dạng tab giữa Phiếu thu và Phiếu chi ở đầu form
- **Khu_vực**: Vùng/khu vực quản lý, lưu trong bảng `areas`, dùng để nhóm các Căn hộ
- **Tài_khoản**: Tài khoản ngân hàng/quỹ tiền mặt dùng để ghi nhận giao dịch thu chi
- **Hợp_đồng**: Hợp đồng thuê liên kết với phiếu thu chi, lưu trong bảng `contracts`
- **Người_nộp**: Tên người nộp tiền (đối với phiếu thu) hoặc người nhận tiền (đối với phiếu chi)
- **Hạch_toán_KQKD**: Toggle cho phép hạch toán kết quả kinh doanh, phân bổ thu chi vào nhiều kỳ thanh toán
- **Đính_kèm**: File ảnh đính kèm phiếu thu chi (biên lai, hóa đơn), lưu trong Supabase Storage
- **Thẻ_thống_kê**: Các card hiển thị tổng thu, tổng chi, thu - chi ở phía trên danh sách

## Yêu cầu

### Yêu cầu 1: Cập nhật thẻ thống kê từ 4 thẻ sang 3 thẻ

**User Story:** Là một Người_dùng, tôi muốn xem thống kê thu chi với 3 thẻ (Tổng Thu, Tổng Chi, Thu - Chi) theo đúng thiết kế, để nắm bắt nhanh tình hình tài chính.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị đúng 3 Thẻ_thống_kê phía trên danh sách: Tổng Thu (màu xanh lá, icon dấu +), Tổng Chi (màu đỏ/cam, icon dấu -), Thu - Chi (màu xanh dương, icon tài liệu)
2. THE Hệ_thống SHALL loại bỏ thẻ "Tổng số phiếu" khỏi phần thống kê
3. THE Hệ_thống SHALL hiển thị số tiền trên mỗi Thẻ_thống_kê theo định dạng tiền tệ Việt Nam (phân cách hàng nghìn bằng dấu chấm, hậu tố "đ")
4. THE Hệ_thống SHALL cập nhật giá trị các Thẻ_thống_kê khi bộ lọc thay đổi

### Yêu cầu 2: Cập nhật cột Thao tác sang nút icon riêng biệt

**User Story:** Là một Người_dùng, tôi muốn thao tác nhanh trên phiếu thu chi bằng các nút icon riêng biệt thay vì dropdown menu, để thao tác trực quan và nhanh hơn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị Cột_Thao_tác với 3 nút icon riêng biệt nằm cạnh nhau theo thứ tự: Nút_Duyệt hoặc Nút_Bỏ_Duyệt (tùy trạng thái), Nút_Chỉnh_Sửa, Nút_Xóa
2. THE Hệ_thống SHALL loại bỏ hoàn toàn DropdownMenu khỏi Cột_Thao_tác
3. WHEN Phiếu_thu_chi có trạng thái UNAPPROVED, THE Hệ_thống SHALL hiển thị Nút_Duyệt (icon checkmark màu xanh lá)
4. WHEN Phiếu_thu_chi có trạng thái APPROVED, THE Hệ_thống SHALL hiển thị Nút_Bỏ_Duyệt (icon X màu cam)
5. WHILE Phiếu_thu_chi có trạng thái APPROVED, THE Hệ_thống SHALL vô hiệu hóa (disabled) Nút_Chỉnh_Sửa và Nút_Xóa
6. WHEN Người_dùng click Nút_Duyệt, THE Hệ_thống SHALL gọi hàm onApprove với id của phiếu
7. WHEN Người_dùng click Nút_Bỏ_Duyệt, THE Hệ_thống SHALL gọi hàm onUnapprove với id của phiếu
8. WHEN Người_dùng click Nút_Chỉnh_Sửa (khi phiếu UNAPPROVED), THE Hệ_thống SHALL gọi hàm onEdit với thông tin phiếu
9. WHEN Người_dùng click Nút_Xóa (khi phiếu UNAPPROVED), THE Hệ_thống SHALL gọi hàm onDelete với id của phiếu

### Yêu cầu 3: Cập nhật thứ tự cột và bổ sung cột mới trong bảng danh sách

**User Story:** Là một Người_dùng, tôi muốn bảng danh sách hiển thị đúng thứ tự cột và có thêm cột Người nhận/trả, Tài khoản theo thiết kế, để xem đầy đủ thông tin phiếu.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị các cột bảng theo thứ tự: Mã (code), Thao tác (action buttons), Tên (name), Số tiền (total_amount), Tòa nhà (building_name), Ngày thu/chi (voucher_date), Người nhận/trả (payer_name), Tài khoản (account_name)
2. THE Hệ_thống SHALL hiển thị cột "Người nhận/trả" với giá trị từ trường payer_name của Phiếu_thu_chi
3. THE Hệ_thống SHALL hiển thị cột "Tài khoản" với giá trị từ trường account_name của Phiếu_thu_chi
4. THE Hệ_thống SHALL loại bỏ các cột "Loại" (badge Phiếu thu/Phiếu chi), "Phòng", "Khách hàng" khỏi bảng danh sách
5. THE Hệ_thống SHALL hiển thị cột "Số tiền" với màu xanh cho phiếu thu và màu đỏ cho phiếu chi, kèm dấu + hoặc - tương ứng

### Yêu cầu 4: Bổ sung bộ lọc Khu vực, Giường, Tài khoản

**User Story:** Là một Người_dùng, tôi muốn lọc phiếu thu chi theo khu vực, giường, và tài khoản, để tìm kiếm chính xác hơn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị thanh bộ lọc ngang (inline filter bar) phía trên bảng với các dropdown: Chọn khoảng thời gian, Chọn khu vực, Chọn tòa nhà, Chọn phòng, Chọn giường, Tài khoản
2. WHEN Người_dùng chọn Khu_vực, THE Hệ_thống SHALL lọc dropdown Tòa nhà chỉ hiển thị các tòa nhà thuộc Khu_vực đã chọn
3. WHEN Người_dùng chọn Tòa nhà, THE Hệ_thống SHALL lọc dropdown Phòng chỉ hiển thị các phòng thuộc Tòa nhà đã chọn
4. WHEN Người_dùng chọn Phòng, THE Hệ_thống SHALL lọc dropdown Giường chỉ hiển thị các giường thuộc Phòng đã chọn
5. THE Hệ_thống SHALL hiển thị dropdown Tài_khoản cho phép lọc phiếu theo tài khoản giao dịch
6. WHEN Người_dùng thay đổi bất kỳ bộ lọc nào, THE Hệ_thống SHALL cập nhật danh sách phiếu và Thẻ_thống_kê tương ứng
7. THE Hệ_thống SHALL hiển thị bộ lọc dạng inline (luôn hiển thị) thay vì ẩn sau nút toggle

### Yêu cầu 5: Chuyển form tạo phiếu sang dạng Tab Toggle

**User Story:** Là một Người_dùng, tôi muốn chuyển đổi giữa Phiếu thu và Phiếu chi bằng tab toggle trực quan, để thao tác nhanh và rõ ràng hơn.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị tiêu đề dialog là "PHIẾU THU/CHI" (in hoa)
2. THE Hệ_thống SHALL hiển thị Tab_Toggle ở đầu form với 2 tab: "Phiếu thu" (icon mũi tên lên) và "Phiếu chi" (icon mũi tên xuống)
3. THE Hệ_thống SHALL loại bỏ RadioGroup (radio buttons) cho lựa chọn loại phiếu
4. WHEN Người_dùng click tab "Phiếu thu", THE Hệ_thống SHALL chuyển loại phiếu sang INCOME và cập nhật label các trường tương ứng (Tên phiếu thu, Ngày thực thu)
5. WHEN Người_dùng click tab "Phiếu chi", THE Hệ_thống SHALL chuyển loại phiếu sang EXPENSE và cập nhật label các trường tương ứng (Tên phiếu chi, Ngày thực chi)
6. THE Hệ_thống SHALL highlight tab đang chọn bằng màu nền khác biệt (tab active có nền màu primary, tab inactive có nền xám)

### Yêu cầu 6: Bổ sung trường mới trong form - Thông tin chung

**User Story:** Là một Người_dùng, tôi muốn nhập thêm thông tin Hợp đồng, Tên người nộp, và Tài khoản khi tạo phiếu thu chi, để ghi nhận đầy đủ thông tin giao dịch.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị section "Thông tin chung" trong form với layout theo ảnh tham chiếu
2. THE Hệ_thống SHALL hiển thị hàng 1: Tòa nhà (dropdown), Phòng (dropdown cascade), Giường (dropdown cascade)
3. THE Hệ_thống SHALL hiển thị hàng 2: Hợp đồng (dropdown), Tên phiếu thu/Lý do thu (*), Tên người nộp (*)
4. THE Hệ_thống SHALL hiển thị hàng 3: Tài khoản (*) (dropdown), Ngày thực thu/chi (*) (date picker)
5. THE Hệ_thống SHALL hiển thị trường Ghi chú (textarea) sau hàng 3
6. WHEN Người_dùng chọn Tòa nhà và Phòng, THE Hệ_thống SHALL lọc dropdown Hợp_đồng chỉ hiển thị các hợp đồng ACTIVE thuộc phòng đã chọn
7. THE Hệ_thống SHALL validate trường Tên người nộp (payer_name) là bắt buộc (không rỗng)
8. THE Hệ_thống SHALL validate trường Tài khoản (account_id) là bắt buộc (không rỗng)

### Yêu cầu 7: Bổ sung Ngày bắt đầu và Ngày kết thúc cho Hạng mục

**User Story:** Là một Người_dùng, tôi muốn khai báo ngày bắt đầu và ngày kết thúc cho mỗi hạng mục, để hạch toán thu chi vào nhiều kỳ thanh toán khi cần.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị section "Hạng mục" với toggle "Hạch toán kết quả kinh doanh?" (switch toggle)
2. THE Hệ_thống SHALL hiển thị mỗi dòng hạng mục với các trường: Hạng mục (*) (dropdown), Số tiền (*) (number input), Ngày bắt đầu (*) (date picker), Ngày kết thúc (*) (date picker)
3. THE Hệ_thống SHALL đặt giá trị mặc định của Ngày bắt đầu và Ngày kết thúc là ngày hiện tại khi thêm hạng mục mới
4. THE Hệ_thống SHALL hiển thị nút "+ Thêm hạng mục" để thêm dòng hạng mục mới
5. THE Hệ_thống SHALL cho phép xóa từng dòng hạng mục bằng nút xóa
6. THE Hệ_thống SHALL validate Ngày bắt đầu không được sau Ngày kết thúc trong cùng một hạng mục
7. THE Hệ_thống SHALL lưu giá trị Hạch_toán_KQKD (boolean) vào trường business_result_accounting của Phiếu_thu_chi
8. THE Hệ_thống SHALL lưu start_date và end_date của mỗi Hạng_mục vào bảng income_expense_items
9. THE Hệ_thống SHALL thay đổi layout hạng mục: mỗi dòng hiển thị Hạng mục (dropdown) + Số tiền (input) + Ngày bắt đầu (date) + Ngày kết thúc (date) trên cùng một hàng, thay vì layout card hiện tại

### Yêu cầu 8: Bổ sung section Đính kèm (Upload ảnh phiếu)

**User Story:** Là một Người_dùng, tôi muốn đính kèm ảnh biên lai hoặc hóa đơn vào phiếu thu chi, để lưu trữ bằng chứng giao dịch.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL hiển thị section "Đính kèm" ở cuối form, sau section Hạng mục
2. THE Hệ_thống SHALL cho phép upload nhiều file ảnh (JPG, PNG, PDF) cho mỗi Phiếu_thu_chi
3. WHEN Người_dùng chọn file hoặc kéo thả file vào vùng upload, THE Hệ_thống SHALL upload file lên Supabase Storage bucket "income-expense-attachments" và lưu URL vào trường attachments (JSON array) của Phiếu_thu_chi
4. THE Hệ_thống SHALL hiển thị preview thumbnail cho các file ảnh đã upload
5. THE Hệ_thống SHALL cho phép xóa file đính kèm đã upload bằng nút xóa trên mỗi thumbnail
6. IF file upload thất bại, THEN THE Hệ_thống SHALL hiển thị thông báo lỗi "Không thể tải lên file đính kèm"
7. THE Hệ_thống SHALL giới hạn kích thước mỗi file tối đa 5MB

### Yêu cầu 9: Cập nhật Database Schema cho các trường mới

**User Story:** Là một Người_dùng, tôi muốn hệ thống lưu trữ đầy đủ các trường mới (tài khoản, người nộp, hợp đồng, đính kèm, hạch toán KQKD, ngày bắt đầu/kết thúc hạng mục), để dữ liệu được ghi nhận chính xác.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL bổ sung cột `payer_name` (TEXT, nullable) vào bảng `income_expenses` để lưu tên người nộp/nhận tiền
2. THE Hệ_thống SHALL bổ sung cột `account_id` (UUID, FK tới bảng accounts, nullable) vào bảng `income_expenses` để lưu tài khoản giao dịch
3. THE Hệ_thống SHALL bổ sung cột `contract_id` (UUID, FK tới bảng contracts, nullable) vào bảng `income_expenses` để liên kết hợp đồng
4. THE Hệ_thống SHALL bổ sung cột `attachments` (JSONB, DEFAULT '[]') vào bảng `income_expenses` để lưu danh sách URL file đính kèm
5. THE Hệ_thống SHALL bổ sung cột `business_result_accounting` (BOOLEAN, DEFAULT false) vào bảng `income_expenses` để lưu trạng thái hạch toán KQKD
6. THE Hệ_thống SHALL bổ sung cột `start_date` (DATE, nullable) vào bảng `income_expense_items` để lưu ngày bắt đầu hạng mục
7. THE Hệ_thống SHALL bổ sung cột `end_date` (DATE, nullable) vào bảng `income_expense_items` để lưu ngày kết thúc hạng mục
8. THE Hệ_thống SHALL tạo bảng `accounts` (nếu chưa tồn tại) với các cột: id (UUID PK), user_id (FK auth.users), name (TEXT NOT NULL), type (TEXT - 'bank'/'cash'), bank_name (TEXT nullable), account_number (TEXT nullable), is_default (BOOLEAN DEFAULT false), created_at, updated_at, deleted_at
9. THE Hệ_thống SHALL áp dụng RLS policies trên bảng `accounts` đảm bảo Người_dùng chỉ truy cập dữ liệu của chính mình

### Yêu cầu 10: Cập nhật Validation Schema (Zod) cho các trường mới

**User Story:** Là một Người_dùng, tôi muốn hệ thống validate đầy đủ các trường mới khi tạo/sửa phiếu, để đảm bảo dữ liệu chính xác.

#### Tiêu chí chấp nhận

1. THE Hệ_thống SHALL validate trường payer_name là bắt buộc (string, min length 1) khi tạo hoặc cập nhật Phiếu_thu_chi
2. THE Hệ_thống SHALL validate trường account_id là bắt buộc (UUID hợp lệ) khi tạo hoặc cập nhật Phiếu_thu_chi
3. THE Hệ_thống SHALL validate trường contract_id là optional (UUID hợp lệ hoặc null)
4. THE Hệ_thống SHALL validate trường business_result_accounting là boolean (mặc định false)
5. THE Hệ_thống SHALL validate trường attachments là mảng string (URL), mặc định mảng rỗng
6. THE Hệ_thống SHALL validate trường start_date của mỗi Hạng_mục là date string hợp lệ (bắt buộc)
7. THE Hệ_thống SHALL validate trường end_date của mỗi Hạng_mục là date string hợp lệ (bắt buộc)
8. THE Hệ_thống SHALL validate start_date không được sau end_date trong cùng một Hạng_mục
9. FOR ALL đối tượng Phiếu_thu_chi input hợp lệ với các trường mới, Zod schema validation SHALL chấp nhận và parse thành công (round-trip property)
10. FOR ALL đối tượng Phiếu_thu_chi input thiếu trường bắt buộc mới (payer_name, account_id), Zod schema validation SHALL từ chối và trả về lỗi tương ứng
