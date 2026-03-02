# Kế hoạch Triển khai: Tái triển khai Thu chi (Income/Expense)

## Tổng quan

Tái triển khai hoàn toàn module Thu chi trong hệ thống Resident. Database schema, triggers, và RPC functions đã có sẵn — không cần thay đổi. Hooks, helpers, và validation files đã tồn tại — cần cập nhật lại cho khớp design. Tập trung vào: (1) Zod validation schemas, (2) Pure helper functions, (3) Property-based tests, (4) Query + mutation hooks, (5) Từng UI Component riêng biệt (Stats, Filters, List, Form, ItemSelector, ImportDialog, TypeForm), (6) Page assembly. Sử dụng TypeScript, React 18, Supabase, shadcn/ui, TanStack React Query, React Hook Form + Zod, fast-check.

**Lưu ý quan trọng:** Mỗi phần UI component được tách thành task riêng biệt. Khi triển khai từng component, có thể yêu cầu người dùng gửi ảnh tham chiếu (screenshot) để đảm bảo UI khớp 100% với thiết kế gốc. Nếu bộ nhớ không đủ, sẽ yêu cầu gửi lại ảnh cho phần đang triển khai.

## Tasks

- [x] 1. Cập nhật Zod validation schemas và types
  - [x] 1.1 Cập nhật `src/lib/incomeExpenseValidation.ts` với các Zod schemas theo design
    - Đảm bảo `itemSchema`: income_expense_type_id (string min 1), description (nullable optional), quantity (int min 1), unit_price (number min 0)
    - Đảm bảo `incomeExpenseFormSchema`: type (enum INCOME/EXPENSE), name (min 1), building_id (min 1), room_id/bed_id/tenant_id (nullable optional), voucher_date (min 1), notes (nullable optional), items (array min 1)
    - Đảm bảo `excelImportRowSchema`: type, building_name, room_name (optional), name, voucher_date, item_name, amount
    - Đảm bảo `incomeExpenseTypeFormSchema`: name (min 1), type (enum income/expense), description (nullable optional), is_default (boolean default false)
    - Export types: `IncomeExpenseFormValues`, `ExcelImportRow`, `IncomeExpenseTypeFormValues`
    - _Yêu cầu: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.10, 12.11_

  - [x] 1.2 Viết property test: Zod validation round-trip (Property 6)
    - **Property 6: Zod validation round-trip**
    - Với bất kỳ `IncomeExpenseFormValues` hợp lệ, parsing qua `incomeExpenseFormSchema` phải thành công và trả về object tương đương
    - File: `src/lib/__tests__/incomeExpenseValidation.property.test.ts`
    - **Validates: Requirements 12.10**

  - [x] 1.3 Viết property test: Zod validation rejects invalid input (Property 7)
    - **Property 7: Zod validation rejects invalid input**
    - Với bất kỳ input thiếu trường bắt buộc hoặc items rỗng hoặc items có quantity < 1 / unit_price < 0 / missing type_id, `safeParse` phải trả về success = false
    - File: `src/lib/__tests__/incomeExpenseValidation.property.test.ts`
    - **Validates: Requirements 2.11, 2.12, 3.5, 12.1–12.8, 12.11**

- [x] 2. Cập nhật pure helper functions
  - [x] 2.1 Cập nhật `src/hooks/useIncomeExpensesHelpers.ts` theo design
    - Đảm bảo tất cả helper functions: `createVoucherPayload`, `canEditVoucher`, `canDeleteVoucher`, `applyApproval`, `applyUnapproval`, `filterNonDeleted`, `applyVoucherFilters`, `paginateList`, `computeIncomeExpenseStats`, `filterRoomsByBuilding`, `filterBedsByRoom`, `generateVoucherCode`, `isValidVoucherCode`, `validateImportRows`, `calculateTotalFromItems`
    - _Yêu cầu: 1.2, 1.6, 4.5, 5.2, 5.3, 6.1, 6.2, 7.3, 7.4, 8.1, 9.5, 9.7, 11.4, 11.5, 11.8, 11.9, 12.9, 13.2, 13.3_

  - [x] 2.2 Viết property test: Stats computation invariants (Property 1)
    - **Property 1: Stats computation invariants**
    - `computeIncomeExpenseStats` trả về totalIncome = sum INCOME amounts, totalExpense = sum EXPENSE amounts, difference = totalIncome - totalExpense, totalTransactions = list length
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 1.2, 8.1, 8.2**

  - [x] 2.3 Viết property test: Pagination bounds (Property 2)
    - **Property 2: Pagination bounds**
    - `paginateList` trả về tối đa pageSize items, totalCount = list length, items là contiguous slice
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 1.6**

  - [x] 2.4 Viết property test: Cascading filter correctness (Property 3)
    - **Property 3: Cascading filter correctness**
    - `filterRoomsByBuilding` chỉ trả về rooms có building_id khớp; `filterBedsByRoom` chỉ trả về beds có room_id khớp
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.4, 2.5, 13.2, 13.3**

  - [x] 2.5 Viết property test: Amount calculation invariants (Property 4)
    - **Property 4: Amount calculation invariants**
    - item amount = quantity × unit_price; `calculateTotalFromItems` = sum of all item amounts
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.8, 3.3, 11.5, 11.6, 11.8, 11.9**

  - [x] 2.6 Viết property test: New voucher always UNAPPROVED with valid code (Property 5)
    - **Property 5: New voucher always UNAPPROVED with valid code**
    - `createVoucherPayload` luôn trả về approval_status = 'UNAPPROVED'; `generateVoucherCode` sinh mã đúng format; `isValidVoucherCode` trả về true cho mã hợp lệ
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.10, 3.4, 11.4**

  - [x] 2.7 Viết property test: Edit/delete guard by approval status (Property 8)
    - **Property 8: Edit/delete guard by approval status**
    - `canEditVoucher` và `canDeleteVoucher` trả về true khi và chỉ khi status = 'UNAPPROVED'
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 4.5, 5.3, 12.9**

  - [x] 2.8 Viết property test: Approve/unapprove round-trip (Property 9)
    - **Property 9: Approve/unapprove round-trip**
    - `applyApproval` → APPROVED + populated approved_by/at; `applyUnapproval` → UNAPPROVED + cleared
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 6.1, 6.2**

  - [x] 2.9 Viết property test: Soft-delete filtering (Property 10)
    - **Property 10: Soft-delete filtering**
    - `filterNonDeleted` chỉ trả về items có deleted_at === null
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 5.2**

  - [x] 2.10 Viết property test: Voucher filter correctness (Property 11)
    - **Property 11: Voucher filter correctness**
    - `applyVoucherFilters` chỉ trả về vouchers khớp TẤT CẢ filter criteria; filters null → trả về tất cả
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 7.3, 7.4**

  - [x] 2.11 Viết property test: Import row validation partitioning (Property 12)
    - **Property 12: Import row validation partitioning**
    - `validateImportRows` phân chia thành validRows + errors, tổng = input length
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 9.5, 9.7**

- [x] 3. Checkpoint - Đảm bảo validation và helpers hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 4. Cập nhật hooks query và mutation
  - [x] 4.1 Cập nhật `src/hooks/useIncomeExpenses.ts` - types và query hooks
    - Đảm bảo types: `IncomeExpenseFilters`, `IncomeExpenseItem`, `IncomeExpenseWithRelations` khớp design
    - Đảm bảo `useIncomeExpenses(filters, pagination, searchQuery?)` query với joins (buildings, rooms, beds, tenants), apply filters, search (ilike trên name, code, tenant_name), sắp xếp voucher_date desc, phân trang
    - Đảm bảo `useIncomeExpenseStats(filters)` trả về: totalIncome, totalExpense, difference, totalTransactions
    - _Yêu cầu: 1.2, 1.4, 1.5, 1.6, 1.7, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_

  - [x] 4.2 Cập nhật `src/hooks/useIncomeExpenses.ts` - mutation hooks
    - Đảm bảo `useCreateIncomeExpense()`: INSERT voucher + INSERT items, status=UNAPPROVED, invalidate queries, toast success
    - Đảm bảo `useUpdateIncomeExpense()`: UPDATE voucher + DELETE old items + INSERT new items (chỉ khi UNAPPROVED)
    - Đảm bảo `useDeleteIncomeExpense()`: UPDATE deleted_at (soft-delete, chỉ khi UNAPPROVED)
    - Đảm bảo `useApproveIncomeExpense()`: RPC `approve_voucher(id)`
    - Đảm bảo `useUnapproveIncomeExpense()`: RPC `unapprove_voucher(id)`
    - Đảm bảo `useImportIncomeExpenses()`: batch create từ parsed Excel rows
    - _Yêu cầu: 2.10, 3.4, 4.1–4.4, 5.1, 5.2, 6.1, 6.2, 9.5, 9.6_

  - [x] 4.3 Cập nhật `src/hooks/useIncomeExpenseTypes.ts`
    - Đảm bảo `useIncomeExpenseTypes(filterType?)` query lọc theo type (income/expense)
    - Đảm bảo `useCreateIncomeExpenseType()` tạo loại mới
    - _Yêu cầu: 10.1, 10.2, 10.3, 10.4_

- [x] 5. Checkpoint - Đảm bảo hooks hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.


- [x] 6. Tái triển khai UI: IncomeExpenseStats — Thẻ thống kê
  - [x] 6.1 Tái triển khai `src/components/income-expenses/IncomeExpenseStats.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần thống kê nếu cần*
    - 4 thẻ Card: Tổng thu (xanh emerald, icon TrendingUp), Tổng chi (đỏ, icon TrendingDown), Chênh lệch (xanh/đỏ tuỳ giá trị, icon ArrowUpDown), Tổng số phiếu (xanh dương, icon FileText)
    - Layout: `grid grid-cols-2 lg:grid-cols-4`, mỗi Card có `border-l-4` với màu tương ứng
    - Props: `stats: { totalIncome, totalExpense, difference, totalTransactions }`, `isLoading?`
    - Format tiền VND: `toLocaleString('vi-VN') + ' đ'`
    - Skeleton loading state khi isLoading = true
    - _Yêu cầu: 1.2, 8.1, 8.3_

- [x] 7. Tái triển khai UI: IncomeExpenseFilters — Thanh bộ lọc
  - [x] 7.1 Tái triển khai `src/components/income-expenses/IncomeExpenseFilters.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần bộ lọc nếu cần*
    - Toggle mở/đóng panel lọc bằng nút icon SlidersHorizontal (3 gạch)
    - Props: `filters: IncomeExpenseFilters`, `onChange: (filters) => void`
    - Các tiêu chí lọc (grid responsive):
      - Căn hộ (dropdown danh sách buildings)
      - Phòng (dropdown cascade theo Căn hộ đã chọn)
      - Sổ quỹ (dropdown — placeholder, disabled)
      - Loại phiếu (dropdown: Tất cả / Phiếu thu / Phiếu chi)
      - Từ ngày — Đến ngày (date inputs)
      - Trạng thái duyệt (dropdown: Tất cả / Đã duyệt / Chưa duyệt)
    - Cascading: chọn Căn hộ → reset Phòng
    - Nút "Áp dụng" và "Xoá bộ lọc"
    - _Yêu cầu: 7.1, 7.2, 7.3, 7.4_

- [x] 8. Tái triển khai UI: IncomeExpenseList — Bảng danh sách phiếu
  - [x] 8.1 Tái triển khai `src/components/income-expenses/IncomeExpenseList.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần bảng danh sách nếu cần*
    - Props: `vouchers`, `isLoading`, `onEdit`, `onDelete`, `onApprove`, `onUnapprove`, `pagination`, `totalCount`
    - Bảng cột: Mã phiếu + Badge trạng thái duyệt, Ngày (dd/MM/yyyy), Loại (Badge Thu xanh / Chi đỏ), Tên phiếu (truncate), Căn hộ, Phòng, Khách hàng, Tổng tiền (format VND, xanh cho thu / đỏ cho chi), Thao tác
    - _Yêu cầu: 1.4, 1.5, 6.3_

  - [x] 8.2 Triển khai cột Thao tác trong IncomeExpenseList
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho dropdown thao tác nếu cần*
    - DropdownMenu thao tác: Duyệt/Bỏ duyệt (toggle theo trạng thái), Cập nhật (disabled khi APPROVED), Xoá (disabled khi APPROVED)
    - _Yêu cầu: 4.5, 5.3, 6.1, 6.2_

  - [x] 8.3 Triển khai phân trang và empty/loading states trong IncomeExpenseList
    - Phân trang với DataTablePagination, page size selector
    - Badge: APPROVED (xanh, "Đã duyệt"), UNAPPROVED (cam, "Chưa duyệt")
    - Empty state: EmptyState component khi không có phiếu
    - Loading state: Skeleton rows
    - _Yêu cầu: 1.6_

- [x] 9. Checkpoint - Đảm bảo Stats, Filters, List hiển thị đúng
  - Đảm bảo tất cả components render đúng, hỏi người dùng nếu có thắc mắc.

- [x] 10. Tái triển khai UI: IncomeExpenseItemSelector — Dialog chọn hạng mục
  - [x] 10.1 Tái triển khai `src/components/income-expenses/IncomeExpenseItemSelector.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho dialog chọn hạng mục nếu cần*
    - Props: `open`, `onOpenChange`, `voucherType`, `onSelect`, `selectedTypeIds`
    - Danh sách checkbox Loại_thu_chi, lọc theo voucherType (INCOME → income, EXPENSE → expense)
    - Nút "Thêm" mở IncomeExpenseTypeForm inline để tạo loại mới
    - Nút "Huỷ" và "Xác nhận" trả về danh sách types đã chọn
    - Auto-check loại mới tạo
    - _Yêu cầu: 2.6, 2.7, 10.1, 10.2, 10.3, 10.4_

- [x] 11. Tái triển khai UI: IncomeExpenseTypeForm — Form tạo loại thu chi
  - [x] 11.1 Cập nhật `src/components/income-expense-types/IncomeExpenseTypeForm.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho form tạo loại thu chi nếu cần*
    - Form inline trong ItemSelector: Tên loại (*), Loại (thu/chi), Mô tả
    - Sử dụng `incomeExpenseTypeFormSchema` validation
    - Sau tạo thành công, tự động thêm vào danh sách chọn và auto-check
    - Props: `defaultType`, `onCreated`, `onCancel`
    - _Yêu cầu: 10.1, 10.2_

- [x] 12. Tái triển khai UI: IncomeExpenseForm — Dialog form tạo/sửa phiếu (Phần 1: Layout và chọn loại phiếu)
  - [x] 12.1 Triển khai layout chính và phần chọn loại phiếu trong `src/components/income-expenses/IncomeExpenseForm.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho form tạo/sửa phiếu nếu cần*
    - Props: `open`, `onOpenChange`, `voucher` (null = tạo mới), `defaultType`
    - Dialog form với RadioGroup chọn loại: Phiếu thu / Phiếu chi
    - Validation bằng `incomeExpenseFormSchema` qua React Hook Form zodResolver
    - Nút Hủy / Lưu
    - _Yêu cầu: 2.1, 2.2, 3.1, 3.2_

- [x] 13. Tái triển khai UI: IncomeExpenseForm — (Phần 2: Cascading dropdowns)
  - [x] 13.1 Triển khai cascading dropdowns trong IncomeExpenseForm
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần dropdown liên tầng nếu cần*
    - Căn hộ (*) → Phòng → Giường → Khách hàng (searchable)
    - Chọn Căn hộ → reset Phòng, Giường, Khách hàng
    - Chọn Phòng → reset Giường
    - Trường bắt buộc đánh dấu (*)
    - Tên phiếu (*), Ngày thu/chi (*), Ghi chú
    - _Yêu cầu: 2.3, 2.4, 2.5, 3.1, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [x] 14. Tái triển khai UI: IncomeExpenseForm — (Phần 3: Quản lý hạng mục)
  - [x] 14.1 Triển khai phần hạng mục trong IncomeExpenseForm
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần hạng mục nếu cần*
    - Nút (+) "Thêm hạng mục" mở IncomeExpenseItemSelector
    - Danh sách items: Tên loại (readonly), Mô tả (input), Số lượng (input, default 1), Đơn giá (input), Thành tiền (auto = qty × price, readonly)
    - Nút xoá item (icon Trash2)
    - Tổng cộng hiển thị cuối danh sách
    - Validation: ít nhất 1 hạng mục, hiển thị lỗi "Vui lòng thêm ít nhất 1 hạng mục"
    - _Yêu cầu: 2.6, 2.7, 2.8, 2.9, 2.11, 2.12, 3.3_

- [x] 15. Tái triển khai UI: IncomeExpenseForm — (Phần 4: Mode sửa phiếu)
  - [x] 15.1 Triển khai mode sửa phiếu trong IncomeExpenseForm
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho form sửa phiếu nếu cần*
    - Pre-fill form từ voucher data khi mode sửa (voucher !== null)
    - Cho phép chỉnh sửa tất cả trường ngoại trừ Mã_phiếu (code) và ngày tạo
    - Cho phép thêm, sửa, xoá Hạng_mục trong phiếu đang sửa
    - Mode tạo mới: gọi `useCreateIncomeExpense`, toast "Dữ liệu đã được TẠO thành công"
    - Mode sửa: gọi `useUpdateIncomeExpense`, toast "Dữ liệu đã được CẬP NHẬT thành công"
    - Hiển thị thông báo "Phiếu đã được duyệt. Vui lòng bỏ duyệt trước khi sửa." nếu phiếu APPROVED
    - Hiển thị lỗi validation inline cho từng trường
    - _Yêu cầu: 2.10, 2.11, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 16. Checkpoint - Đảm bảo Form, ItemSelector, TypeForm hoạt động
  - Đảm bảo tất cả form components hoạt động đúng, hỏi người dùng nếu có thắc mắc.

- [x] 17. Tái triển khai UI: IncomeExpenseImportDialog — (Phần 1: Upload và tải file mẫu)
  - [x] 17.1 Triển khai phần upload trong `src/components/income-expenses/IncomeExpenseImportDialog.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho dialog nhập Excel nếu cần*
    - Props: `open`, `onOpenChange`
    - Link "Tải file mẫu tại đây" → download Excel template với cột: Loại phiếu (*), Căn hộ (*), Phòng, Tên phiếu (*), Ngày (*), Hạng mục (*), Số tiền (*)
    - Vùng upload: click "Chọn file" hoặc drag-drop, chấp nhận .xlsx/.xls
    - _Yêu cầu: 9.1, 9.2, 9.3, 9.4_

- [x] 18. Tái triển khai UI: IncomeExpenseImportDialog — (Phần 2: Preview và nhập dữ liệu)
  - [x] 18.1 Triển khai phần preview và nhập dữ liệu trong IncomeExpenseImportDialog
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho phần preview nếu cần*
    - Parse file Excel → validate từng dòng bằng `excelImportRowSchema`
    - Bảng preview: hiển thị dữ liệu parsed, trạng thái hợp lệ/lỗi từng dòng, chi tiết lỗi
    - Nút "Nhập dữ liệu" → gọi `useImportIncomeExpenses`
    - Hiển thị kết quả: số dòng thành công, số dòng lỗi, chi tiết lỗi
    - Toast "Dữ liệu đã được TẠO thành công" khi nhập thành công
    - _Yêu cầu: 9.5, 9.6, 9.7_

- [x] 19. Checkpoint - Đảm bảo Import Dialog hoạt động
  - Đảm bảo import flow hoạt động end-to-end, hỏi người dùng nếu có thắc mắc.

- [x] 20. Tích hợp trang IncomeExpensePage — Layout và kết nối
  - [x] 20.1 Tái triển khai `src/pages/payments/IncomeExpensePage.tsx`
    - 📸 *Yêu cầu người dùng gửi ảnh tham chiếu cho trang tổng thể nếu cần*
    - Layout: Header (breadcrumb "Tài chính > Thu chi") → Toolbar (nút (+) Thêm phiếu, nút Import mũi tên lên, nút Lọc 3 gạch, ô Tìm kiếm) → IncomeExpenseStats → IncomeExpenseFiltersBar → IncomeExpenseList
    - State: filters, searchQuery, isFormOpen, isImportOpen, editingVoucher, formType, deleteTarget, pagination
    - Kết nối hooks: `useIncomeExpenses`, `useIncomeExpenseStats`, mutations (delete, approve, unapprove)
    - _Yêu cầu: 1.1, 1.2, 1.3, 1.7_

  - [x] 20.2 Triển khai hộp thoại xác nhận xoá và logic duyệt/bỏ duyệt
    - Hộp thoại xác nhận xoá (AlertDialog): hiển thị khi click Xoá, xác nhận → soft-delete, toast "Dữ liệu đã được XOÁ thành công"
    - Logic duyệt: gọi `useApproveIncomeExpense`, toast "Phiếu đã được DUYỆT thành công"
    - Logic bỏ duyệt: gọi `useUnapproveIncomeExpense`, toast "Phiếu đã được BỎ DUYỆT thành công"
    - _Yêu cầu: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3_

  - [x] 20.3 Đảm bảo routing và navigation
    - Đảm bảo route cho IncomeExpensePage đã đăng ký trong App.tsx
    - Đảm bảo navigation sidebar trỏ đúng tới route Thu chi
    - _Yêu cầu: 1.1_

- [x] 21. Checkpoint cuối - Đảm bảo toàn bộ tính năng hoạt động
  - Đảm bảo tất cả tests pass và toàn bộ flow hoạt động, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo truy vết
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra 12 correctness properties từ design document
- Sử dụng fast-check cho property-based tests (đã cài trong dự án)
- Database schema, triggers, RPC đã có sẵn — không cần thay đổi
- Hooks, helpers, và validation files đã tồn tại — cần cập nhật, không tạo mới từ đầu
- 📸 Mỗi phần UI component có thể yêu cầu người dùng gửi ảnh tham chiếu (screenshot) để đảm bảo UI khớp 100% với thiết kế gốc. Nếu bộ nhớ không đủ, sẽ yêu cầu gửi lại ảnh cho phần đang triển khai.
