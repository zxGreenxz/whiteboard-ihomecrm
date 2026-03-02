# Kế hoạch triển khai: Căn chỉnh UI Thu chi theo ảnh tham chiếu

## Tổng quan

Triển khai các thay đổi UI và bổ sung tính năng cho module Thu chi (Income/Expense) theo ảnh tham chiếu. Bao gồm: database migration, cập nhật validation schemas, cập nhật components UI, tạo component mới, và property-based tests.

## Tasks

- [x] 1. Database migration và tạo bảng accounts
  - [x] 1.1 Tạo file migration `supabase/migrations/20251120000001_thu_chi_ui_alignment.sql`
    - Tạo bảng `accounts` với các cột: id (UUID PK), user_id (FK auth.users), name (TEXT NOT NULL), type (TEXT CHECK 'bank'/'cash'), bank_name, account_number, is_default, created_at, updated_at, deleted_at
    - Áp dụng RLS policies trên bảng `accounts`: SELECT, INSERT, UPDATE, DELETE với điều kiện `user_id = auth.uid()`
    - Thêm cột `payer_name` (TEXT nullable) vào bảng `income_expenses`
    - Thêm cột `account_id` (UUID FK accounts(id) nullable) vào bảng `income_expenses`
    - Thêm cột `contract_id` (UUID FK contracts(id) nullable) vào bảng `income_expenses`
    - Thêm cột `attachments` (JSONB DEFAULT '[]') vào bảng `income_expenses`
    - Thêm cột `business_result_accounting` (BOOLEAN DEFAULT false) vào bảng `income_expenses`
    - Thêm cột `start_date` (DATE nullable) vào bảng `income_expense_items`
    - Thêm cột `end_date` (DATE nullable) vào bảng `income_expense_items`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

- [x] 2. Cập nhật Zod validation schemas và types
  - [x] 2.1 Cập nhật Zod schemas trong file validation hiện có
    - Thêm `start_date` và `end_date` vào item schema với refine kiểm tra start_date <= end_date
    - Thêm `payer_name` (string, min 1), `account_id` (string, uuid), `contract_id` (optional), `business_result_accounting` (boolean, default false), `attachments` (array string url, default []) vào form schema
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [x] 2.2 Cập nhật TypeScript types/interfaces
    - Cập nhật `IncomeExpenseWithRelations` thêm: payer_name, account_id, account_name, contract_id, attachments, business_result_accounting
    - Cập nhật `IncomeExpenseItem` thêm: start_date, end_date
    - Tạo interface `Account` (id, user_id, name, type, bank_name, account_number, is_default, created_at, updated_at)
    - _Requirements: 9.1-9.8, 10.1-10.8_

  - [ ]* 2.3 Viết property test cho Zod schema round-trip (Property 10)
    - **Property 10: Zod schema round-trip cho phiếu thu chi**
    - Tạo arbitrary cho object phiếu thu chi hợp lệ (đầy đủ trường bắt buộc mới), parse qua schema, kiểm tra output tương đương input
    - **Validates: Requirements 10.9**

  - [ ]* 2.4 Viết property test cho Zod schema reject thiếu trường bắt buộc (Property 11)
    - **Property 11: Zod schema reject khi thiếu trường bắt buộc**
    - Tạo arbitrary cho object hợp lệ, xóa payer_name hoặc account_id, kiểm tra schema reject
    - **Validates: Requirements 10.10**

  - [ ]* 2.5 Viết property test cho validation ngày bắt đầu/kết thúc hạng mục (Property 8)
    - **Property 8: Validation ngày bắt đầu/kết thúc hạng mục**
    - Tạo arbitrary cho cặp ngày, kiểm tra start_date > end_date bị reject, start_date <= end_date được accept
    - **Validates: Requirements 7.6, 10.6, 10.7, 10.8**

  - [ ]* 2.6 Viết property test cho validation trường bắt buộc mới (Property 7)
    - **Property 7: Validation trường bắt buộc mới**
    - Tạo arbitrary cho payer_name rỗng/whitespace hoặc account_id không hợp lệ, kiểm tra schema reject
    - **Validates: Requirements 6.7, 6.8, 10.1, 10.2**

- [x] 3. Tạo hook useAccounts và cập nhật useIncomeExpenses
  - [x] 3.1 Tạo hook `src/hooks/useAccounts.ts`
    - Query bảng `accounts` với TanStack Query, filter by user_id (RLS tự xử lý)
    - Export `useAccounts` trả về danh sách accounts
    - _Requirements: 9.8, 9.9_

  - [x] 3.2 Cập nhật hook `src/hooks/useIncomeExpenses.ts`
    - Cập nhật query select để join bảng `accounts` lấy `account_name`
    - Thêm filter params: area_id, bed_id, account_id vào query
    - Cập nhật stats query trả về 3 giá trị: totalIncome, totalExpense, difference (bỏ totalTransactions)
    - Cập nhật mutation create/update để gửi các trường mới: payer_name, account_id, contract_id, attachments, business_result_accounting
    - Cập nhật mutation create/update items để gửi start_date, end_date
    - _Requirements: 1.1, 1.2, 1.4, 3.2, 3.3, 4.1, 4.5, 4.6, 9.1-9.7_

- [x] 4. Checkpoint - Kiểm tra database và data layer
  - Đảm bảo migration chạy thành công, schemas validate đúng, hooks query/mutate đúng. Hỏi người dùng nếu có thắc mắc.

- [x] 5. Cập nhật IncomeExpenseStats (4 thẻ → 3 thẻ)
  - [x] 5.1 Cập nhật component `src/components/income-expenses/IncomeExpenseStats.tsx`
    - Giảm từ 4 thẻ xuống 3 thẻ: Tổng Thu (icon Plus, xanh lá), Tổng Chi (icon Minus, đỏ/cam), Thu - Chi (icon FileText, xanh dương)
    - Loại bỏ thẻ "Tổng số phiếu"
    - Cập nhật grid layout sang `grid-cols-1 md:grid-cols-3`
    - Hiển thị số tiền theo định dạng VND (dấu chấm phân cách, hậu tố "đ")
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 5.2 Viết property test cho định dạng tiền tệ VND (Property 1)
    - **Property 1: Định dạng tiền tệ VND**
    - Tạo arbitrary cho số nguyên/thực, kiểm tra formatVND output kết thúc bằng " đ" và dùng dấu chấm phân cách
    - **Validates: Requirements 1.3**

- [x] 6. Cập nhật IncomeExpenseFilters (toggle panel → inline)
  - [x] 6.1 Cập nhật component `src/components/income-expenses/IncomeExpenseFilters.tsx`
    - Chuyển từ toggle panel sang inline filter bar (luôn hiển thị)
    - Thêm dropdown: Khu vực, Giường, Tài khoản
    - Thứ tự: Khoảng thời gian | Khu vực | Tòa nhà | Phòng | Giường | Tài khoản
    - Implement cascade logic: Khu vực → Tòa nhà → Phòng → Giường
    - Khi thay đổi parent, reset tất cả child selections
    - Sử dụng hooks useAreas, useBuildings, useRooms, useBeds, useAccounts
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 6.2 Viết property test cho cascade filter (Property 5)
    - **Property 5: Cascade filter chỉ trả về items thuộc parent đã chọn**
    - Tạo arbitrary cho tập dữ liệu areas/buildings/rooms/beds, kiểm tra filter chỉ trả về items có FK đúng parent
    - **Validates: Requirements 4.2, 4.3, 4.4**

- [x] 7. Cập nhật IncomeExpenseList (dropdown → icon buttons, cột mới)
  - [x] 7.1 Cập nhật component `src/components/income-expenses/IncomeExpenseList.tsx`
    - Thay thế DropdownMenu bằng 3 icon buttons: Duyệt/Bỏ duyệt (CheckCircle/XCircle), Chỉnh sửa (Pencil), Xóa (Trash2)
    - Nút Duyệt: hiển thị khi UNAPPROVED, gọi onApprove(id)
    - Nút Bỏ duyệt: hiển thị khi APPROVED, gọi onUnapprove(id)
    - Nút Chỉnh sửa và Xóa: disabled khi APPROVED
    - Thêm cột "Người nhận/trả" (payer_name) và "Tài khoản" (account_name)
    - Loại bỏ cột "Loại" (badge), "Phòng", "Khách hàng"
    - Sắp xếp lại thứ tự cột: Mã, Thao tác, Tên, Số tiền, Tòa nhà, Ngày thu/chi, Người nhận/trả, Tài khoản
    - Cột Số tiền: "+xxx đ" màu xanh cho INCOME, "-xxx đ" màu đỏ cho EXPENSE
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 7.2 Viết property test cho trạng thái nút Duyệt/Bỏ duyệt (Property 2)
    - **Property 2: Trạng thái phiếu quyết định nút Duyệt/Bỏ duyệt**
    - Tạo arbitrary cho approval_status, kiểm tra UNAPPROVED → CheckCircle, APPROVED → XCircle, không bao giờ đồng thời
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 7.3 Viết property test cho phiếu đã duyệt vô hiệu hóa nút (Property 3)
    - **Property 3: Phiếu đã duyệt vô hiệu hóa Chỉnh sửa và Xóa**
    - Tạo arbitrary cho phiếu APPROVED, kiểm tra nút Chỉnh sửa và Xóa disabled
    - **Validates: Requirements 2.5**

  - [ ]* 7.4 Viết property test cho dấu và màu số tiền (Property 4)
    - **Property 4: Số tiền hiển thị đúng dấu và màu theo loại phiếu**
    - Tạo arbitrary cho type INCOME/EXPENSE và amount, kiểm tra dấu +/- và class màu tương ứng
    - **Validates: Requirements 3.5**

- [x] 8. Cập nhật IncomeExpenseForm (tab toggle, trường mới, layout hạng mục)
  - [x] 8.1 Cập nhật form: Tab toggle thay thế RadioGroup
    - Thay thế RadioGroup bằng shadcn Tabs component
    - 2 tab: "Phiếu thu" (ArrowUp icon) và "Phiếu chi" (ArrowDown icon)
    - Tab active: nền primary, text trắng; Tab inactive: nền xám
    - Dialog title: "PHIẾU THU/CHI" (in hoa)
    - Khi chuyển tab, cập nhật labels tương ứng (Tên phiếu thu/chi, Ngày thực thu/chi)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 8.2 Cập nhật form: Thêm trường mới trong section "Thông tin chung"
    - Hàng 1: Tòa nhà (dropdown), Phòng (cascade), Giường (cascade)
    - Hàng 2: Hợp đồng (dropdown, lọc theo phòng + ACTIVE), Tên phiếu thu/chi, Tên người nộp
    - Hàng 3: Tài khoản (dropdown từ useAccounts), Ngày thực thu/chi
    - Hàng 4: Ghi chú (textarea)
    - Cascade: Tòa nhà + Phòng → lọc Hợp đồng ACTIVE
    - Validate payer_name bắt buộc, account_id bắt buộc
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 8.3 Cập nhật form: Layout hạng mục mới với ngày bắt đầu/kết thúc
    - Toggle "Hạch toán kết quả kinh doanh?" (Switch)
    - Mỗi dòng hạng mục: Hạng mục (dropdown) + Số tiền (input) + Ngày bắt đầu (date) + Ngày kết thúc (date) + Xóa
    - Default ngày bắt đầu/kết thúc = ngày hiện tại khi thêm mới
    - Nút "+ Thêm hạng mục"
    - Validate start_date <= end_date
    - Lưu business_result_accounting, start_date, end_date
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [ ]* 8.4 Viết property test cho hợp đồng lọc theo phòng (Property 6)
    - **Property 6: Hợp đồng lọc theo phòng chỉ trả về hợp đồng ACTIVE**
    - Tạo arbitrary cho danh sách contracts với status và room_id khác nhau, kiểm tra filter chỉ trả về ACTIVE + đúng room_id
    - **Validates: Requirements 6.6**

- [x] 9. Tạo component AttachmentUpload và tích hợp vào form
  - [x] 9.1 Tạo component `src/components/income-expenses/AttachmentUpload.tsx`
    - Props: attachments (string[]), onChange, disabled, userId
    - Vùng upload drag & drop hoặc click chọn file
    - Chấp nhận: JPG, PNG, PDF; tối đa 5MB/file
    - Upload lên Supabase Storage bucket "income-expense-attachments" sử dụng `src/lib/storage.ts`
    - Hiển thị preview thumbnails với nút xóa
    - Hiển thị toast lỗi khi upload thất bại hoặc file không hợp lệ
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 9.2 Tích hợp AttachmentUpload vào IncomeExpenseForm
    - Thêm section "Đính kèm" sau section Hạng mục
    - Bind attachments field từ form state
    - _Requirements: 8.1, 8.3_

  - [ ]* 9.3 Viết property test cho validation file đính kèm (Property 9)
    - **Property 9: Validation file đính kèm**
    - Tạo arbitrary cho file type và size, kiểm tra reject khi type không hợp lệ hoặc size > 5MB
    - **Validates: Requirements 8.2, 8.7**

- [x] 10. Cập nhật IncomeExpensePage để kết nối tất cả
  - [x] 10.1 Cập nhật `src/pages/payments/IncomeExpensePage.tsx`
    - Truyền stats mới (3 giá trị) cho IncomeExpenseStats
    - Truyền filter params mới (area_id, bed_id, account_id) cho IncomeExpenseFilters
    - Truyền payer_name, account_name cho IncomeExpenseList
    - Cập nhật state management cho các filter mới
    - Đảm bảo thẻ thống kê cập nhật khi filter thay đổi
    - _Requirements: 1.4, 4.6_

- [x] 11. Checkpoint cuối - Đảm bảo tất cả hoạt động
  - Đảm bảo tất cả tests pass, kiểm tra tích hợp giữa các component, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Tasks đánh dấu `*` là optional, có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến requirements cụ thể để đảm bảo truy vết
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra tính đúng đắn trên mọi input (fast-check)
- Unit tests kiểm tra các ví dụ cụ thể và edge cases
