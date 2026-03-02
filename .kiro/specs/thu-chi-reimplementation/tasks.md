# Kế hoạch Triển khai: Tái triển khai Thu chi (Income/Expense)

## Tổng quan

Tái triển khai hoàn toàn module Thu chi trong hệ thống Resident. Database schema, triggers, và RPC functions đã có sẵn — không cần thay đổi. Tập trung vào: (1) Zod validation schemas, (2) Pure helper functions, (3) Property-based tests cho 12 correctness properties, (4) Query + mutation hooks, (5) UI Components (Stats, Filters, List, Form, ItemSelector, ImportDialog, TypeForm), (6) Page assembly + routing. Sử dụng TypeScript, React 18, Supabase, shadcn/ui, TanStack React Query, React Hook Form + Zod, fast-check.

## Tasks

- [ ] 1. Cập nhật Zod validation schemas và types
  - [x] 1.1 Cập nhật `src/lib/incomeExpenseValidation.ts` với các Zod schemas theo design
    - Đảm bảo `itemSchema`: income_expense_type_id (string min 1), description (nullable optional), quantity (int min 1), unit_price (number min 0)
    - Đảm bảo `incomeExpenseFormSchema`: type (enum INCOME/EXPENSE), name (min 1), building_id (min 1), room_id/bed_id/tenant_id (nullable optional), voucher_date (min 1), notes (nullable optional), items (array min 1)
    - Đảm bảo `excelImportRowSchema`: type, building_name, room_name (optional), name, voucher_date, item_name, amount
    - Đảm bảo `incomeExpenseTypeFormSchema`: name (min 1), type (enum income/expense), description (nullable optional), is_default (boolean default false)
    - Export types: `IncomeExpenseFormValues`, `ExcelImportRow`, `IncomeExpenseTypeFormValues`
    - _Yêu cầu: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.10, 12.11_

  - [ ]* 1.2 Viết property test: Zod validation round-trip
    - **Property 6: Zod validation round-trip**
    - Với bất kỳ `IncomeExpenseFormValues` hợp lệ, parsing qua `incomeExpenseFormSchema` phải thành công và trả về object tương đương
    - File: `src/lib/__tests__/incomeExpenseValidation.property.test.ts`
    - **Validates: Requirements 12.10**

  - [ ]* 1.3 Viết property test: Zod validation rejects invalid input
    - **Property 7: Zod validation rejects invalid input**
    - Với bất kỳ input thiếu trường bắt buộc hoặc items rỗng hoặc items có quantity < 1 / unit_price < 0 / missing type_id, `safeParse` phải trả về success = false
    - File: `src/lib/__tests__/incomeExpenseValidation.property.test.ts`
    - **Validates: Requirements 2.10, 2.11, 3.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.11**

- [ ] 2. Cập nhật pure helper functions
  - [x] 2.1 Cập nhật `src/hooks/useIncomeExpensesHelpers.ts` theo design
    - Đảm bảo tất cả helper functions theo bảng trong design: `createVoucherPayload`, `canEditVoucher`, `canDeleteVoucher`, `applyApproval`, `applyUnapproval`, `filterNonDeleted`, `applyVoucherUpdate`, `applyVoucherFilters`, `paginateList`, `computeIncomeExpenseStats`, `filterRoomsByBuilding`, `filterBedsByRoom`, `generateVoucherCode`, `isValidVoucherCode`, `validateImportRows`, `calculateTotalFromItems`
    - Đảm bảo `computeIncomeExpenseStats` trả về: totalIncome, totalExpense, difference, totalTransactions
    - Đảm bảo `applyVoucherFilters` lọc theo: building_id, room_id, type, start_date, end_date, approval_status
    - Đảm bảo `paginateList` trả về: data (slice), totalCount
    - _Yêu cầu: 1.2, 1.6, 4.5, 4.6, 5.2, 5.3, 6.1, 6.2, 7.3, 7.4, 8.1, 9.5, 9.7, 11.4, 11.5, 11.8, 11.9, 12.9, 13.2, 13.3_

  - [ ]* 2.2 Viết property test: Stats computation invariants
    - **Property 1: Stats computation invariants**
    - Với bất kỳ danh sách vouchers, `computeIncomeExpenseStats` phải trả về totalIncome = sum INCOME amounts, totalExpense = sum EXPENSE amounts, difference = totalIncome - totalExpense, totalTransactions = list length
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 1.2, 8.1, 8.2**

  - [ ]* 2.3 Viết property test: Pagination bounds
    - **Property 2: Pagination bounds**
    - Với bất kỳ list và page/pageSize hợp lệ, `paginateList` trả về tối đa pageSize items, totalCount = list length, items là contiguous slice
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 1.6**

  - [ ]* 2.4 Viết property test: Cascading filter correctness
    - **Property 3: Cascading filter correctness**
    - `filterRoomsByBuilding` chỉ trả về rooms có building_id khớp; `filterBedsByRoom` chỉ trả về beds có room_id khớp
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.4, 2.5, 13.2, 13.3**

  - [ ]* 2.5 Viết property test: Amount calculation invariants
    - **Property 4: Amount calculation invariants**
    - Với item có quantity > 0 và unit_price >= 0, amount = quantity × unit_price; `calculateTotalFromItems` = sum of all item amounts
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.7, 11.5, 11.6, 11.8, 11.9**

  - [ ]* 2.6 Viết property test: New voucher always UNAPPROVED with valid code
    - **Property 5: New voucher always UNAPPROVED with valid code**
    - `createVoucherPayload` luôn trả về approval_status = 'UNAPPROVED'; `generateVoucherCode` sinh mã đúng format PT/PC{YYMM}{3-digit seq}; `isValidVoucherCode` trả về true cho mã hợp lệ
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 2.9, 3.4, 11.4**

  - [ ]* 2.7 Viết property test: Edit/delete guard by approval status
    - **Property 8: Edit/delete guard by approval status**
    - `canEditVoucher` và `canDeleteVoucher` trả về true khi và chỉ khi status = 'UNAPPROVED'
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 4.5, 5.3, 12.9**

  - [ ]* 2.8 Viết property test: Approve/unapprove round-trip
    - **Property 9: Approve/unapprove round-trip**
    - `applyApproval` → status APPROVED + populated approved_by/at; sau đó `applyUnapproval` → status UNAPPROVED + cleared approved_by/at
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 2.9 Viết property test: Soft-delete filtering
    - **Property 10: Soft-delete filtering**
    - `filterNonDeleted` chỉ trả về items có deleted_at === null, length = count non-deleted items
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 5.2**

  - [ ]* 2.10 Viết property test: Voucher filter correctness
    - **Property 11: Voucher filter correctness**
    - `applyVoucherFilters` chỉ trả về vouchers khớp TẤT CẢ filter criteria; khi tất cả filters null → trả về tất cả
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 7.3, 7.4**

  - [ ]* 2.11 Viết property test: Import row validation partitioning
    - **Property 12: Import row validation partitioning**
    - `validateImportRows` phân chia thành validRows + errors sao cho: validRows.length + errors.length = input length, mỗi validRow pass schema, mỗi error fail schema
    - File: `src/hooks/__tests__/useIncomeExpenses.property.test.ts`
    - **Validates: Requirements 9.5, 9.7**

- [ ] 3. Checkpoint - Đảm bảo validation và helpers hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [ ] 4. Cập nhật hooks query và mutation
  - [x] 4.1 Cập nhật `src/hooks/useIncomeExpenses.ts` - types và query hooks
    - Đảm bảo types: `IncomeExpenseFilters`, `IncomeExpenseItem`, `IncomeExpenseWithRelations` khớp design
    - Đảm bảo `useIncomeExpenses(filters, pagination, searchQuery?)` query với joins (buildings, rooms, beds, tenants), apply filters, search (ilike trên name, code, tenant_name), sắp xếp voucher_date desc, phân trang range(from, to)
    - Đảm bảo `useIncomeExpenseStats(filters)` trả về: totalIncome, totalExpense, difference, totalTransactions
    - _Yêu cầu: 1.2, 1.4, 1.5, 1.6, 1.7, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_

  - [x] 4.2 Cập nhật `src/hooks/useIncomeExpenses.ts` - mutation hooks
    - Đảm bảo `useCreateIncomeExpense()`: INSERT voucher + INSERT items, status=UNAPPROVED, invalidate queries, toast success
    - Đảm bảo `useUpdateIncomeExpense()`: UPDATE voucher + DELETE old items + INSERT new items (chỉ khi UNAPPROVED), invalidate queries, toast success
    - Đảm bảo `useDeleteIncomeExpense()`: UPDATE deleted_at (soft-delete, chỉ khi UNAPPROVED), invalidate queries, toast success
    - Đảm bảo `useApproveIncomeExpense()`: RPC `approve_voucher(id)`, invalidate queries, toast success
    - Đảm bảo `useUnapproveIncomeExpense()`: RPC `unapprove_voucher(id)`, invalidate queries, toast success
    - Đảm bảo `useImportIncomeExpenses()`: batch create từ parsed Excel rows, validate, toast kết quả
    - _Yêu cầu: 2.9, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 6.1, 6.2, 9.5, 9.6_

  - [x] 4.3 Cập nhật `src/hooks/useIncomeExpenseTypes.ts`
    - Đảm bảo `useIncomeExpenseTypes(filterType?)` query lọc theo type (income/expense)
    - Đảm bảo `useCreateIncomeExpenseType()` tạo loại mới
    - Đảm bảo `useDeleteIncomeExpenseType()` kiểm tra usage trước khi xoá
    - _Yêu cầu: 10.1, 10.2, 10.3, 10.4_

- [ ] 5. Checkpoint - Đảm bảo hooks hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [ ] 6. Tái triển khai component IncomeExpenseStats
  - [x] 6.1 Tái triển khai `src/components/income-expenses/IncomeExpenseStats.tsx`
    - 4 thẻ Card: Tổng thu (xanh, icon), Tổng chi (đỏ, icon), Chênh lệch (xanh nếu >= 0, đỏ nếu < 0), Tổng số phiếu
    - Props: `stats: { totalIncome, totalExpense, difference, totalTransactions }`, `isLoading?`
    - Format tiền VND: `toLocaleString('vi-VN') + ' đ'`
    - Skeleton loading state
    - _Yêu cầu: 1.2, 8.1, 8.3_

- [ ] 7. Tái triển khai component IncomeExpenseFiltersBar
  - [x] 7.1 Tái triển khai `src/components/income-expenses/IncomeExpenseFilters.tsx`
    - Props: `filters: IncomeExpenseFilters`, `onChange: (filters) => void`
    - Toggle mở/đóng panel lọc (nút icon 3 gạch)
    - Các tiêu chí: Căn hộ (dropdown), Phòng (cascade theo Căn hộ), Sổ quỹ, Loại phiếu (Tất cả/Thu/Chi), Thời gian (từ ngày - đến ngày), Trạng thái duyệt (Tất cả/Đã duyệt/Chưa duyệt)
    - Cascading: chọn Căn hộ → reset Phòng
    - Nút "Áp dụng" và "Xoá bộ lọc"
    - _Yêu cầu: 7.1, 7.2, 7.3, 7.4_

- [ ] 8. Tái triển khai component IncomeExpenseList
  - [x] 8.1 Tái triển khai `src/components/income-expenses/IncomeExpenseList.tsx`
    - Props: `vouchers`, `isLoading`, `onEdit`, `onDelete`, `onApprove`, `onUnapprove`, `pagination`, `totalCount`
    - Bảng cột: Mã phiếu + Badge trạng thái, Ngày, Loại (Thu/Chi badge), Tên phiếu, Căn hộ, Phòng, Khách hàng, Tổng tiền (format VND), Thao tác
    - DropdownMenu thao tác: Duyệt/Bỏ duyệt, Cập nhật (disabled khi APPROVED), Xoá (disabled khi APPROVED)
    - Sắp xếp voucher_date desc
    - Phân trang với DataTablePagination
    - Badge: APPROVED (xanh, "Đã duyệt"), UNAPPROVED (cam, "Chưa duyệt")
    - Empty state và loading skeleton
    - _Yêu cầu: 1.4, 1.5, 1.6, 4.5, 5.3, 6.3_

- [ ] 9. Checkpoint - Đảm bảo components hiển thị hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [ ] 10. Tái triển khai IncomeExpenseItemSelector và TypeForm
  - [x] 10.1 Tái triển khai `src/components/income-expenses/IncomeExpenseItemSelector.tsx`
    - Props: `open`, `onOpenChange`, `voucherType`, `onSelect`, `selectedTypeIds`
    - Danh sách checkbox Loại_thu_chi, lọc theo voucherType (INCOME → income, EXPENSE → expense)
    - Nút "Thêm" mở IncomeExpenseTypeForm inline để tạo loại mới
    - Nút "Xác nhận" trả về danh sách types đã chọn
    - _Yêu cầu: 2.6, 2.7, 10.1, 10.2, 10.3, 10.4_

  - [x] 10.2 Cập nhật `src/components/income-expense-types/IncomeExpenseTypeForm.tsx`
    - Form tạo loại thu chi mới inline trong ItemSelector
    - Trường: Tên loại (*), Loại (thu/chi), Mô tả
    - Sử dụng `incomeExpenseTypeFormSchema` validation
    - Sau tạo thành công, tự động thêm vào danh sách chọn
    - _Yêu cầu: 10.1, 10.2_

- [ ] 11. Tái triển khai IncomeExpenseForm
  - [x] 11.1 Tái triển khai `src/components/income-expenses/IncomeExpenseForm.tsx`
    - Props: `open`, `onOpenChange`, `voucher` (null = tạo mới), `defaultType`
    - Dialog form với 2 tab/radio chọn loại: Phiếu thu / Phiếu chi
    - Cascading dropdowns: Căn hộ (*) → Phòng → Giường, Khách hàng (searchable)
    - Reset Phòng khi đổi Căn hộ, reset Giường khi đổi Phòng
    - Phần hạng mục: danh sách items + nút (+) mở ItemSelector
    - Mỗi item: Tên loại (readonly), Mô tả, Số lượng (input), Đơn giá (input), Thành tiền (auto = qty × price), nút xoá
    - Validation bằng `incomeExpenseFormSchema` qua React Hook Form zodResolver
    - Mode tạo mới: form trống, gọi `useCreateIncomeExpense`
    - Mode sửa: pre-fill form từ voucher data, gọi `useUpdateIncomeExpense`
    - Hiển thị lỗi validation inline cho từng trường
    - _Yêu cầu: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [ ] 12. Tái triển khai IncomeExpenseImportDialog
  - [x] 12.1 Tái triển khai `src/components/income-expenses/IncomeExpenseImportDialog.tsx`
    - Props: `open`, `onOpenChange`
    - Link "Tải file mẫu tại đây" → download Excel template với cột: Loại phiếu (*), Căn hộ (*), Phòng, Tên phiếu (*), Ngày (*), Hạng mục (*), Số tiền (*)
    - Vùng upload: click hoặc drag-drop, chấp nhận .xlsx/.xls
    - Parse file → validate từng dòng bằng `excelImportRowSchema` → hiển thị preview
    - Nút "Nhập dữ liệu" → gọi `useImportIncomeExpenses`
    - Hiển thị kết quả: số dòng thành công, số dòng lỗi, chi tiết lỗi
    - _Yêu cầu: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [ ] 13. Checkpoint - Đảm bảo form và import hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 14. Tích hợp trang IncomeExpensePage và routing
  - [x] 14.1 Tái triển khai `src/pages/payments/IncomeExpensePage.tsx`
    - Layout: Header (breadcrumb "Tài chính > Thu chi" + nút (+) Thêm phiếu + nút Import) → IncomeExpenseStats → Search bar + IncomeExpenseFiltersBar → IncomeExpenseList
    - State: filters, searchQuery, isFormOpen, isImportOpen, editingVoucher, formType, deleteTarget
    - Kết nối hooks: `useIncomeExpenses`, `useIncomeExpenseStats`, mutations (delete, approve, unapprove)
    - Tìm kiếm theo tên phiếu, mã phiếu, tên khách hàng
    - Hộp thoại xác nhận xoá (AlertDialog)
    - Pagination với `usePagination`
    - _Yêu cầu: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3_

  - [x] 14.2 Đảm bảo routing và navigation
    - Đảm bảo route cho IncomeExpensePage đã đăng ký trong App.tsx
    - Đảm bảo navigation sidebar trỏ đúng tới route Thu chi
    - _Yêu cầu: 1.1_

- [ ] 15. Checkpoint cuối - Đảm bảo toàn bộ tính năng hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo truy vết
- Checkpoints đảm bảo kiểm tra tăng dần sau mỗi giai đoạn
- Property tests kiểm tra 12 correctness properties từ design document
- Sử dụng fast-check cho property-based tests (đã cài trong dự án)
- Database schema, triggers, RPC đã có sẵn — không cần thay đổi
- Hooks và helpers hiện có cần được cập nhật/cải thiện, không tạo mới từ đầu
