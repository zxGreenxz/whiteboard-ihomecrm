# Kế hoạch Triển khai: Tái triển khai Thu chi (Income/Expense)

## Tổng quan

Tái triển khai hoàn toàn module Thu chi (Income/Expense) trong hệ thống Resident. Bao gồm: (1) Database schema mới (3 bảng + triggers + RLS), (2) Validation schemas, (3) Hooks CRUD + duyệt + thống kê, (4) Components cho Phiếu thu/chi, Loại thu chi, Mẫu in thu chi, (5) Pages + routes + tích hợp Sổ quỹ/Hoá đơn. Sử dụng React + TypeScript + Supabase + shadcn/ui + React Query + Zod + fast-check theo pattern hiện có trong dự án.

## Tasks

- [x] 1. Tạo Database Schema: bảng, triggers, RLS policies
  - [x] 1.1 Tạo migration tạo bảng `income_expenses`
    - Tạo bảng với các cột: id (UUID PK), user_id (FK auth.users), code (TEXT UNIQUE per user), type (TEXT CHECK IN INCOME/EXPENSE), name (TEXT NOT NULL), building_id (FK buildings NOT NULL), room_id (FK rooms nullable), bed_id (FK beds nullable), tenant_id (FK tenants nullable), voucher_date (DATE NOT NULL), total_amount (DECIMAL(15,2) DEFAULT 0 CHECK >= 0), approval_status (TEXT DEFAULT 'UNAPPROVED' CHECK IN UNAPPROVED/APPROVED), approved_by (FK auth.users nullable), approved_at (TIMESTAMPTZ nullable), notes (TEXT nullable), created_at, updated_at, deleted_at
    - Tạo indexes trên user_id, building_id, type, approval_status, voucher_date
    - _Yêu cầu: 11.1, 11.4, 11.5, 11.7_

  - [x] 1.2 Tạo migration tạo bảng `income_expense_items`
    - Tạo bảng với các cột: id (UUID PK), income_expense_id (FK income_expenses ON DELETE CASCADE NOT NULL), income_expense_type_id (FK income_expense_types NOT NULL), description (TEXT nullable), quantity (INTEGER DEFAULT 1 CHECK > 0), unit_price (DECIMAL(15,2) DEFAULT 0 CHECK >= 0), amount (DECIMAL(15,2)), notes (TEXT nullable), created_at
    - _Yêu cầu: 11.2_

  - [x] 1.3 Tạo migration tạo bảng `income_expense_templates`
    - Tạo bảng với các cột: id (UUID PK), user_id (FK auth.users NOT NULL), code (TEXT UNIQUE per user), name (TEXT NOT NULL), description (TEXT nullable), template_file_url (TEXT nullable), is_default (BOOLEAN DEFAULT false), is_income_template (BOOLEAN DEFAULT false), field_mappings (JSONB nullable), created_at, updated_at, deleted_at
    - _Yêu cầu: 11.3_

  - [x] 1.4 Tạo triggers và RPC functions
    - Trigger `auto_generate_voucher_code()`: tự sinh PT{YYMM}{seq} cho INCOME, PC{YYMM}{seq} cho EXPENSE trên INSERT income_expenses
    - Trigger `auto_calc_item_amount()`: tự tính amount = quantity * unit_price trên INSERT/UPDATE income_expense_items
    - Trigger `auto_recalc_total_amount()`: tự tính lại total_amount = SUM(items.amount) trên INSERT/UPDATE/DELETE income_expense_items
    - Trigger `auto_update_updated_at()`: tự cập nhật updated_at trên UPDATE income_expenses, income_expense_templates
    - Trigger `generate_template_code()`: tự sinh mã cho mẫu in trên INSERT income_expense_templates
    - RPC `approve_voucher(voucher_id)`: SET approval_status=APPROVED, approved_by=auth.uid(), approved_at=now()
    - RPC `unapprove_voucher(voucher_id)`: SET approval_status=UNAPPROVED, clear approved_by/approved_at
    - _Yêu cầu: 1.6, 2.2, 4.2, 4.3, 11.6, 11.8_

  - [x] 1.5 Tạo RLS policies cho tất cả bảng mới
    - income_expenses: SELECT/INSERT/UPDATE chỉ cho user_id = auth.uid(), SELECT thêm điều kiện deleted_at IS NULL
    - income_expense_items: ALL qua subquery income_expense_id IN (SELECT id FROM income_expenses WHERE user_id = auth.uid())
    - income_expense_templates: ALL cho user_id = auth.uid()
    - _Yêu cầu: 6.3, 11.4_

- [x] 2. Tạo Zod validation schemas và types dùng chung
  - [x] 2.1 Tạo file `src/lib/incomeExpenseValidation.ts` với các Zod schemas
    - Tạo `incomeExpenseFormSchema` cho form Phiếu thu/chi (type, name, building_id, voucher_date bắt buộc; items array min 1)
    - Tạo `incomeExpenseTypeFormSchema` cho form Loại thu chi (name, type bắt buộc)
    - Tạo `incomeExpenseTemplateFormSchema` cho form Mẫu in (name bắt buộc)
    - Tạo `excelImportRowSchema` cho dòng import Excel (type, building_name, name, voucher_date, item_name, amount)
    - Tạo hàm `validateTotalAmount(items)` tính tổng quantity * unit_price
    - Tạo hàm `canEditVoucher(status)` trả về true nếu UNAPPROVED
    - _Yêu cầu: 1.7, 2.4, 3.1, 3.3, 5.6, 9.2, 9.3_

  - [x]* 2.2 Viết property test cho validation từ chối input thiếu trường bắt buộc
    - **Property 2: Validation từ chối input thiếu trường bắt buộc**
    - **Validates: Yêu cầu 1.7, 2.4**

  - [x]* 2.3 Viết property test cho tổng tiền = SUM items
    - **Property 3: Tổng tiền phiếu = Tổng thành tiền các hạng mục**
    - **Validates: Yêu cầu 1.5, 11.8**

  - [x]* 2.4 Viết property test cho quyền sửa/xoá phụ thuộc trạng thái duyệt
    - **Property 4: Quyền sửa/xoá phụ thuộc trạng thái duyệt**
    - **Validates: Yêu cầu 3.1, 3.2**

- [x] 3. Checkpoint - Đảm bảo database schema và validation hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 4. Tạo hook `useIncomeExpenses.ts` với query, mutation, duyệt, thống kê
  - [x] 4.1 Tạo file `src/hooks/useIncomeExpenses.ts` với các query hooks
    - Tạo types: `IncomeExpenseWithRelations`, `IncomeExpenseItem`, `IncomeExpenseFilters`
    - Tạo `useIncomeExpenses(filters, pagination, searchQuery?)` query danh sách phiếu kèm join buildings, rooms, beds, tenants, items; lọc theo building_id, room_id, type, date range, approval_status, search; phân trang
    - Tạo `useIncomeExpenseStats(filters)` query thống kê: totalIncome, totalExpense, difference, totalTransactions
    - _Yêu cầu: 6.1, 6.2, 6.3, 7.2, 7.3, 8.1, 8.2_

  - [x] 4.2 Thêm các mutation hooks vào `useIncomeExpenses.ts`
    - Tạo `useCreateIncomeExpense()` insert phiếu + items trong 1 transaction, status=UNAPPROVED
    - Tạo `useUpdateIncomeExpense()` cập nhật phiếu (chỉ khi UNAPPROVED), cập nhật items
    - Tạo `useDeleteIncomeExpense()` soft-delete (chỉ khi UNAPPROVED)
    - Tạo `useImportIncomeExpenses()` xử lý import từ Excel, validate từng dòng, tạo phiếu hàng loạt
    - _Yêu cầu: 1.6, 2.2, 3.5, 3.6, 5.4_

  - [x] 4.3 Thêm các mutation hooks duyệt/bỏ duyệt vào `useIncomeExpenses.ts`
    - Tạo `useApproveIncomeExpense()` gọi RPC `approve_voucher(id)`
    - Tạo `useUnapproveIncomeExpense()` gọi RPC `unapprove_voucher(id)`
    - _Yêu cầu: 4.2, 4.3_

  - [x]* 4.4 Viết property test cho phiếu mới luôn có trạng thái UNAPPROVED và mã hợp lệ
    - **Property 1: Phiếu mới luôn có trạng thái UNAPPROVED và mã phiếu hợp lệ**
    - **Validates: Yêu cầu 1.6, 2.2**

  - [x]* 4.5 Viết property test cho soft-delete ẩn khỏi danh sách
    - **Property 5: Soft-delete ẩn khỏi danh sách**
    - **Validates: Yêu cầu 3.4, 6.4**

  - [x]* 4.6 Viết property test cho cập nhật phiếu round-trip
    - **Property 6: Cập nhật phiếu round-trip**
    - **Validates: Yêu cầu 3.6, 11.6**

  - [x]* 4.7 Viết property test cho duyệt rồi bỏ duyệt là round-trip
    - **Property 7: Duyệt rồi bỏ duyệt là round-trip**
    - **Validates: Yêu cầu 4.2, 4.3**

- [x] 5. Tái triển khai hook `useIncomeExpenseTypes.ts` và tạo hook `useIncomeExpenseTemplates.ts`
  - [x] 5.1 Tái triển khai `src/hooks/useIncomeExpenseTypes.ts`
    - Tạo `useIncomeExpenseTypes(filterType?)` query danh sách loại thu chi, lọc theo type (income/expense)
    - Tạo `useCreateIncomeExpenseType()` tạo loại mới
    - Tạo `useUpdateIncomeExpenseType()` cập nhật loại
    - Tạo `useDeleteIncomeExpenseType()` xoá loại (kiểm tra đang sử dụng trước khi xoá)
    - _Yêu cầu: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 5.2 Tạo file `src/hooks/useIncomeExpenseTemplates.ts`
    - Tạo `useIncomeExpenseTemplates(filterIsIncome?)` query danh sách mẫu in
    - Tạo `useCreateIncomeExpenseTemplate()` tạo mẫu mới
    - Tạo `useUpdateIncomeExpenseTemplate()` cập nhật mẫu
    - Tạo `useDeleteIncomeExpenseTemplate()` soft-delete mẫu
    - Tạo `useToggleDefaultTemplate()` toggle mặc định (đảm bảo chỉ 1 mẫu mặc định mỗi loại)
    - _Yêu cầu: 10.1, 10.2, 10.3, 10.7, 10.8, 10.9_

  - [x]* 5.3 Viết property test cho loại thu chi CRUD round-trip
    - **Property 14: Loại thu chi CRUD round-trip**
    - **Validates: Yêu cầu 9.3**

  - [x]* 5.4 Viết property test cho mẫu in - chỉ một mẫu mặc định cho mỗi loại
    - **Property 15: Mẫu in thu chi - chỉ một mẫu mặc định cho mỗi loại**
    - **Validates: Yêu cầu 10.7**

  - [x]* 5.5 Viết property test cho mẫu in có mã tự sinh
    - **Property 16: Mẫu in thu chi có mã tự sinh**
    - **Validates: Yêu cầu 10.2**

- [x] 6. Checkpoint - Đảm bảo tất cả hooks hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 7. Triển khai module Loại thu chi (Settings)
  - [x] 7.1 Tạo component `src/components/income-expense-types/IncomeExpenseTypeList.tsx`
    - Bảng danh sách loại thu chi với các cột: Tên loại, Loại (Thu/Chi badge xanh/đỏ), Mô tả, Mặc định (toggle), Thao tác (Sửa/Xoá)
    - Sử dụng shadcn/ui Table, Badge, Button
    - _Yêu cầu: 9.1, 9.6_

  - [x] 7.2 Tạo component `src/components/income-expense-types/IncomeExpenseTypeForm.tsx`
    - Dialog form thêm/sửa loại thu chi với các trường: Tên loại (*), Loại (Thu/Chi) (*), Mô tả, Mặc định (toggle)
    - Sử dụng `incomeExpenseTypeFormSchema` từ Zod validation
    - Hỗ trợ cả mode thêm mới (type=null) và sửa (type có giá trị, điền sẵn form)
    - _Yêu cầu: 9.2, 9.3, 9.4_

  - [x] 7.3 Tạo trang `src/pages/settings/IncomeExpenseTypesPage.tsx` và đăng ký route
    - Layout: Header (tiêu đề + nút (+) Thêm loại) → IncomeExpenseTypeList
    - Kết nối IncomeExpenseTypeList + IncomeExpenseTypeForm + useIncomeExpenseTypes
    - Hộp thoại xác nhận xoá, xử lý lỗi xoá loại đang sử dụng
    - Đăng ký route `/settings/income-expense-types` trong App.tsx
    - _Yêu cầu: 9.1, 9.5_

- [x] 8. Triển khai module Mẫu in thu chi (Settings)
  - [x] 8.1 Tạo component `src/components/income-expense-templates/IncomeExpenseTemplateList.tsx`
    - Bảng danh sách mẫu in với các cột: Mã, Tên mẫu, Xem mẫu PDF (link), Mặc định (toggle), Thao tác (Sửa/Xoá)
    - Toggle mặc định gọi `useToggleDefaultTemplate`
    - _Yêu cầu: 10.1, 10.6, 10.7_

  - [x] 8.2 Tạo component `src/components/income-expense-templates/IncomeExpenseTemplateForm.tsx`
    - Dialog form thêm/sửa mẫu in với các trường: Tên mẫu (*), Mô tả, File mẫu in (upload PDF), Mặc định (toggle), Là mẫu biên lai thu? (toggle), Field mappings (JSONB)
    - Upload file sử dụng `src/lib/storage.ts`
    - Sử dụng `incomeExpenseTemplateFormSchema` từ Zod validation
    - Hỗ trợ cả mode thêm mới và sửa
    - _Yêu cầu: 10.3, 10.4, 10.5, 10.8_

  - [x] 8.3 Tạo trang `src/pages/settings/IncomeExpenseTemplatesPage.tsx` và đăng ký route
    - Layout: Header (tiêu đề + nút (+) Thêm mới) → IncomeExpenseTemplateList
    - Kết nối IncomeExpenseTemplateList + IncomeExpenseTemplateForm + useIncomeExpenseTemplates
    - Hộp thoại xác nhận xoá
    - Đăng ký route `/settings/income-expense-templates` trong App.tsx
    - _Yêu cầu: 10.1, 10.9_

- [x] 9. Checkpoint - Đảm bảo module Settings hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 10. Triển khai components Phiếu thu/chi - Phần hiển thị
  - [x] 10.1 Tạo component `src/components/income-expenses/IncomeExpenseStats.tsx`
    - Hiển thị 4 thẻ thống kê: Tổng thu (xanh, icon ArrowUpCircle), Tổng chi (đỏ, icon ArrowDownCircle), Chênh lệch Thu - Chi (xanh nếu >= 0, đỏ nếu < 0), Tổng số giao dịch (icon FileText)
    - Sử dụng `useIncomeExpenseStats` hook, cập nhật khi thay đổi bộ lọc
    - Sử dụng shadcn/ui Card + Lucide icons
    - _Yêu cầu: 8.1, 8.2, 8.3_

  - [x] 10.2 Tạo component `src/components/income-expenses/IncomeExpenseFilters.tsx`
    - Bộ lọc: Căn hộ, Phòng (cascade theo Căn hộ), Sổ quỹ, Loại phiếu (Thu/Chi), Thời gian (từ ngày - đến ngày), Trạng thái duyệt
    - Hiển thị khi ấn nút Lọc (3 gạch)
    - Nút Áp dụng và Xoá bộ lọc
    - Sử dụng shadcn/ui Select, Input (type=date)
    - _Yêu cầu: 7.1, 7.2_

  - [x] 10.3 Tạo component `src/components/income-expenses/IncomeExpenseList.tsx`
    - Bảng danh sách phiếu với các cột: Mã phiếu (code + badge trạng thái xanh/vàng), Ngày, Loại (Thu badge xanh / Chi badge đỏ), Tên phiếu, Căn hộ, Phòng, Khách hàng, Tổng tiền (xanh cho thu, đỏ cho chi), Thao tác
    - Cột Thao tác: Duyệt/Bỏ duyệt, Cập nhật (disabled khi APPROVED), Xoá (disabled khi APPROVED)
    - Phân trang sử dụng `usePagination` hook hiện có
    - _Yêu cầu: 4.4, 6.1, 6.2, 3.1, 3.2, 3.3_

  - [x]* 10.4 Viết property test cho bộ lọc và tìm kiếm chỉ trả về kết quả phù hợp
    - **Property 9: Bộ lọc và tìm kiếm chỉ trả về kết quả phù hợp**
    - **Validates: Yêu cầu 7.2, 7.3**

  - [x]* 10.5 Viết property test cho phân trang đúng
    - **Property 10: Phân trang đúng**
    - **Validates: Yêu cầu 6.2**

  - [x]* 10.6 Viết property test cho thống kê đúng
    - **Property 11: Thống kê đúng**
    - **Validates: Yêu cầu 8.1, 8.2**

- [x] 11. Triển khai Form phiếu thu/chi và Import Excel
  - [x] 11.1 Tạo component `src/components/income-expenses/IncomeExpenseItemSelector.tsx`
    - Dialog chọn hạng mục (Loại thu chi) với checkbox cho mỗi loại
    - Lọc theo voucherType (INCOME → income, EXPENSE → expense)
    - Nút "Thêm" để tạo Loại_thu_chi mới inline (mở IncomeExpenseTypeForm)
    - Nút "Xác nhận" để chọn các loại đã tích
    - _Yêu cầu: 1.4, 1.5_

  - [x] 11.2 Tạo component `src/components/income-expenses/IncomeExpenseForm.tsx`
    - Dialog form thêm/sửa phiếu thu/chi
    - Bước 1: Chọn loại phiếu (Phiếu thu / Phiếu chi) - 2 ô radio
    - Bước 2: Điền thông tin: Căn hộ (*), Phòng (cascade), Giường (cascade), Khách hàng (gợi ý theo Phòng/Giường), Tên phiếu (*), Ngày thu/chi (*), Ghi chú
    - Bước 3: Thêm Hạng mục qua IncomeExpenseItemSelector, mỗi hạng mục hiển thị: Tên loại, Số lượng (input), Đơn giá (input), Thành tiền (auto = quantity * unit_price), nút xoá
    - Sử dụng `incomeExpenseFormSchema` từ Zod validation
    - Cascade dropdown: Building → Room → Bed → Tenant (sử dụng hooks useBuildings, useRooms, useBeds, useTenants hiện có)
    - Hỗ trợ cả mode thêm mới và sửa (pre-fill form khi sửa)
    - _Yêu cầu: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 13.1, 13.2, 13.3, 13.4_

  - [x] 11.3 Tạo component `src/components/income-expenses/IncomeExpenseImportDialog.tsx`
    - Dialog nhập hàng loạt từ Excel
    - Nút "Tải file mẫu tại đây" → download template Excel (sử dụng `src/lib/excelHelpers.ts`)
    - Template columns: Loại phiếu, Căn hộ, Phòng, Tên phiếu, Ngày, Hạng mục, Số tiền
    - Khu vực kéo thả / chọn file để upload
    - Preview dữ liệu file đã tải lên trong bảng
    - Nút "Nhập dữ liệu" → validate từng dòng bằng `excelImportRowSchema` → gọi useImportIncomeExpenses
    - Hiển thị kết quả: số bản ghi thành công, số bản ghi lỗi, chi tiết lỗi từng dòng
    - _Yêu cầu: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x]* 11.4 Viết property test cho cascade dropdown Building → Room → Bed đúng
    - **Property 12: Cascade dropdown Building → Room → Bed đúng**
    - **Validates: Yêu cầu 13.1, 13.2**

  - [x]* 11.5 Viết property test cho gợi ý khách hàng theo phòng/giường đúng
    - **Property 13: Gợi ý khách hàng theo phòng/giường đúng**
    - **Validates: Yêu cầu 13.3**

  - [x]* 11.6 Viết property test cho phiếu thu/chi nhiều hạng mục
    - **Property 17: Phiếu thu/chi nhiều hạng mục**
    - **Validates: Yêu cầu 2.3**

  - [x]* 11.7 Viết property test cho Import Excel - số bản ghi tạo + số lỗi = tổng dòng
    - **Property 8: Import Excel - số bản ghi tạo + số lỗi = tổng dòng**
    - **Validates: Yêu cầu 5.4, 5.6**

- [x] 12. Checkpoint - Đảm bảo form và import hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 13. Tích hợp trang IncomeExpensePage và kết nối toàn bộ
  - [x] 13.1 Tạo trang `src/pages/payments/IncomeExpensePage.tsx`
    - Layout: Header (tiêu đề "Thu chi" + nút (+) Thêm phiếu + nút Import mũi tên lên) → IncomeExpenseStats → Search bar + IncomeExpenseFilters → IncomeExpenseList
    - Quản lý state: filters, isFormOpen, isImportOpen, editingVoucher, formType, searchQuery
    - Kết nối tất cả components đã tạo với hooks useIncomeExpenses, useIncomeExpenseStats
    - Xử lý duyệt/bỏ duyệt đơn lẻ qua IncomeExpenseList
    - Xử lý sửa/xoá đơn lẻ, hộp thoại xác nhận xoá
    - Tìm kiếm theo tên phiếu, tên khách hàng, mã phiếu
    - _Yêu cầu: 1.1, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_

  - [x] 13.2 Đăng ký routes và navigation
    - Đăng ký route `/payments` cho IncomeExpensePage trong App.tsx (thay thế PaymentsPage cũ)
    - Đảm bảo navigation sidebar trỏ đúng tới route mới
    - Đảm bảo routes `/settings/income-expense-types` và `/settings/income-expense-templates` đã đăng ký từ task 7.3 và 8.3
    - _Yêu cầu: 1.1, 9.1, 10.1_

  - [x] 13.3 Tích hợp với Sổ quỹ và Hoá đơn
    - Hiển thị cả khoản Thu/chi từ hoá đơn (payments) và khoản Thu/chi phát sinh ngoài hoá đơn (income_expenses) trong danh sách
    - Phân biệt rõ ràng giữa 2 loại trong danh sách (badge hoặc icon)
    - Khi phiếu được duyệt (APPROVED), ghi nhận giao dịch vào Sổ_quỹ
    - Khi phiếu bị bỏ duyệt (UNAPPROVED), huỷ ghi nhận khỏi Sổ_quỹ
    - _Yêu cầu: 12.1, 12.2, 12.3, 12.4_

- [x] 14. Checkpoint cuối - Đảm bảo toàn bộ tính năng hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo truy vết
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra tính đúng đắn phổ quát, unit tests kiểm tra ví dụ cụ thể và edge cases
- Sử dụng fast-check cho property-based tests (đã cài trong dự án)
- Database schema cần tạo migration mới (khác với meter-reading đã có sẵn)
- Bảng `income_expense_types` đã tồn tại, chỉ cần tái triển khai hook và UI
