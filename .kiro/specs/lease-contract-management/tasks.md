# Implementation Plan: Quản lý Hợp đồng thuê (Lease Contract Management)

## Overview

Triển khai module Quản lý Hợp đồng thuê bao gồm: database migration (bảng `contract_customers` + 5 RPC functions), TypeScript types, 7 Zod validation schemas, 2 React hooks (TanStack Query), 16 UI components (shadcn/ui), Excel import/export, và routing. Triển khai theo thứ tự: database → types → validation → hooks → components (stats, filters, table) → page → form dialog → action dialogs → import/export → routing → tests.

## Tasks

- [x] 1. Database migration và RPC functions
  - [x] 1.1 Tạo migration file `supabase/migrations/20250710000001_lease_contract_management.sql`
    - Tạo bảng `contract_customers` (junction table: contract_id, customer_id, is_representative)
    - Thêm indexes cho contract_id và customer_id
    - Thêm UNIQUE constraint (contract_id, customer_id)
    - Enable RLS với 4 policies (SELECT, INSERT, UPDATE, DELETE) kiểm tra user_id qua contracts
    - Tạo trigger `update_contract_customers_updated_at`
    - Tạo function `check_contract_representative()` đảm bảo chỉ 1 đại diện/hợp đồng
    - Tạo trigger `ensure_single_representative`
    - _Requirements: 2.6_

  - [x] 1.2 Tạo RPC function `renew_contract`
    - Parameters: p_contract_id, p_new_end_date, p_new_rent_price, p_new_deposit, p_notes
    - Validate contract exists và status IN ('ACTIVE', 'EXPIRED')
    - INSERT vào contract_extensions, UPDATE contracts (end_date, rent_price, total_deposit, status = 'ACTIVE')
    - Return JSON { success, extension_id }
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 1.3 Tạo RPC function `transfer_room`
    - Parameters: p_contract_id, p_new_room_id, p_new_bed_id, p_new_rent_price, p_transfer_date, p_notes
    - Validate contract ACTIVE, tạo new contract (copy customers + services), record transfer, terminate old, update room statuses
    - Return JSON { success, new_contract_id, transfer_id }
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 1.4 Tạo RPC function `transfer_contract`
    - Parameters: p_contract_id, p_new_customer_id, p_new_rent_price, p_new_deposit, p_transfer_date, p_notes
    - Validate contract ACTIVE, tạo new contract (same room, new customer), copy services, record transfer, set old status = 'TRANSFERRED'
    - Return JSON { success, new_contract_id, transfer_id }
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 1.5 Tạo RPC functions `terminate_contract_forfeit` và `terminate_contract_move_out`
    - Forfeit: set TERMINATED, record termination (type FORFEIT), free room/bed
    - Move out: calculate settlement (deposit_refund + excess_rent - outstanding_debt - penalty_fee), set TERMINATED, record termination, free room/bed
    - Return JSON { success, termination_id, refund_amount }
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [x] 2. TypeScript types và Zod validation schemas
  - [x] 2.1 Tạo `src/types/contract.ts`
    - Định nghĩa types: ContractStatus, PaymentCycle, ContractStatFilter, ContractDisplayStatus
    - Định nghĩa interfaces: Contract, ContractWithRelations, ContractCustomer, ContractServiceWithDetails, ContractStats, ContractFilters, ContractFormData
    - Implement helper function `getContractDisplayStatus(contract)` — tính display status từ status + end_date + expected_move_out_date
    - Implement constants: CONTRACT_STATUS_CONFIG (label + color per status), PAYMENT_CYCLE_LABELS
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 1.8_

  - [x] 2.2 Tạo `src/lib/contractValidation.ts`
    - Implement 7 Zod schemas: contractFormSchema, renewFormSchema, transferRoomFormSchema, moveOutFormSchema, transferContractFormSchema, terminateForfeitFormSchema, terminateMoveOutFormSchema
    - contractFormSchema: room_id required UUID, start_date required, end_date required, rent_price >= 0, total_deposit >= 0, payment_cycle enum, refine end_date > start_date
    - Export inferred types: ContractFormData, RenewFormData, TransferRoomFormData, MoveOutFormData, TransferContractFormData, TerminateForfeitFormData, TerminateMoveOutFormData
    - _Requirements: 2.12, 4.1, 5.1, 6.1, 7.1, 8.2, 9.1_

- [x] 3. Checkpoint — Verify types and validation
  - Ensure all types compile correctly, ask the user if questions arise.

- [x] 4. React hooks
  - [x] 4.1 Tạo/cập nhật `src/hooks/useContracts.ts`
    - Implement `useContracts()`: query contracts with relations (room → building, contract_customers → customer, contract_services → service)
    - Implement `useContract(id)`: query single contract with full relations
    - Implement `useCreateContract()`: mutation tạo contract + INSERT contract_customers (batch) + INSERT contract_services (batch) + UPDATE room status
    - Implement `useUpdateContract()`: mutation cập nhật contract fields
    - Implement `useDeleteContract()`: mutation xóa contract (kiểm tra financial records trước)
    - Tất cả mutations invalidate queries ['contracts'] on success, hiển thị toast thành công/lỗi
    - _Requirements: 2.11, 2.13, 3.1, 3.2, 3.3, 10.1, 10.2, 10.3_

  - [x] 4.2 Tạo `src/hooks/useContractOperations.ts`
    - Implement `useRenewContract()`: gọi RPC `renew_contract`, invalidate queries
    - Implement `useTransferRoom()`: gọi RPC `transfer_room`, invalidate queries
    - Implement `useRegisterMoveOut()`: mutation UPDATE contracts.expected_move_out_date
    - Implement `useTransferContract()`: gọi RPC `transfer_contract`, invalidate queries
    - Implement `useTerminateForfeit()`: gọi RPC `terminate_contract_forfeit`, invalidate queries
    - Implement `useTerminateMoveOut()`: gọi RPC `terminate_contract_move_out`, invalidate queries
    - Tất cả mutations hiển thị toast thành công/lỗi bằng tiếng Việt
    - _Requirements: 4.2, 4.3, 5.2, 5.3, 6.2, 6.5, 7.2, 7.3, 8.3, 8.4, 9.6_

- [x] 5. Checkpoint — Verify hooks compile
  - Ensure all hooks compile correctly, ask the user if questions arise.

- [x] 6. Core list components
  - [x] 6.1 Tạo `src/components/contracts/ContractStatsCards.tsx`
    - 4 thẻ Card clickable: "Tất cả" (xanh lá), "Sắp hết hạn" (cam), "Quá hạn" (đỏ), "Đã thanh lý" (xám)
    - Props: stats (ContractStats), activeFilter (ContractStatFilter), onFilterChange callback
    - Click thẻ → gọi onFilterChange để lọc bảng theo category
    - _Requirements: 1.1, 1.2_

  - [x] 6.2 Tạo `src/components/contracts/ContractListFilters.tsx`
    - 6 dropdown cascading: Khu vực → Toà nhà (lọc theo area) → Phòng (lọc theo building) → Giường (lọc theo room), Dạng thuê, Chọn tháng
    - Search bar tìm theo mã HĐ, tên khách, SĐT, tên phòng (debounced)
    - Cascading: chọn building → reset room/bed, chọn room → reset bed
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 15.1, 15.2, 15.3, 15.4_

  - [x] 6.3 Tạo `src/components/contracts/ContractListTable.tsx`
    - Bảng với 11 cột: checkbox, Mã HĐ, Trạng thái (color-coded badge), Thao tác (7 icon buttons), Vị trí, Khách hàng, Giá thuê, Tiền cọc, Ngày BĐ, Ngày KT, Người tạo
    - 7 action buttons inline: Cập nhật (Pencil), Gia hạn (CalendarPlus), Chuyển phòng (ArrowRightLeft), ĐK chuyển đi (LogOut), Nhượng HĐ (UserPlus), Thanh lý (FileX), Xóa (Trash2)
    - Action button disabled states theo contract status (Property 9)
    - Checkbox column với select-all header, bulk selection
    - Pagination với configurable page sizes (10, 20, 50, 100)
    - Format VND cho giá thuê và tiền cọc
    - _Requirements: 1.8, 1.9, 1.10, 3.4, 4.4, 5.5, 6.4, 7.4, 10.4, 13.1, 14.1, 14.2, 14.3_

- [x] 7. ContractsPage
  - [x] 7.1 Tạo/cập nhật `src/pages/contracts/ContractsPage.tsx`
    - State management: activeStatFilter, all filter states, pagination, dialog open states, selectedContract, selectedContractIds
    - Gọi useContracts() để load data
    - Compute stats client-side từ full contract list (total, expiring, expired, terminated) dùng getContractDisplayStatus
    - Apply client-side filters (search, area, building, room, bed, rental type, month, stat filter)
    - Render: Breadcrumb → ContractStatsCards → ContractListFilters → Toolbar (Add, Import, Export, Filter toggle) → ContractListTable
    - Wire tất cả dialog open/close handlers
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 1.10_

- [x] 8. Checkpoint — Verify list page renders
  - Ensure the contracts page renders with stats, filters, and table. Ask the user if questions arise.

- [x] 9. Contract form dialog
  - [x] 9.1 Tạo `src/components/contracts/CustomerSelectionDialog.tsx`
    - Dialog tìm kiếm và chọn khách hàng từ danh sách existing
    - Search theo tên, SĐT, CCCD
    - Checkbox multi-select, hiển thị danh sách với full_name, phone, id_number
    - Props: open, onOpenChange, selectedCustomerIds, onSelect callback
    - _Requirements: 2.4, 2.5_

  - [x] 9.2 Tạo `src/components/contracts/ServiceSelectionDialog.tsx`
    - Dialog chọn dịch vụ từ danh sách available services (theo building)
    - Checkbox multi-select, hiển thị tên DV, đơn giá, đơn vị
    - Props: open, onOpenChange, selectedServiceIds, onSelect, buildingId
    - _Requirements: 2.9_

  - [x] 9.3 Tạo `src/components/contracts/ContractFormDialog.tsx`
    - Full-screen dialog (DialogContent max-w-4xl)
    - React Hook Form + Zod (contractFormSchema)
    - Section 1 "Thông tin chung": Toà nhà dropdown → Phòng cascading → Giường cascading, Ngày ký, Ngày BĐ, Hạn HĐ, Mẫu HĐ, Mẫu hoá đơn, Ghi chú
    - Section 2 "Khách hàng": Nút "Thêm khách hàng" → CustomerSelectionDialog, danh sách khách đã chọn với radio đại diện, nút xóa
    - Section 3 "Tiền thuê & Tiền cọc": Tiền thuê, Chu kỳ TT, Ngày BĐ tính tiền, Tiền cọc, Đã đặt cọc (auto-populated readonly), Tiền cọc phải đóng (calculated readonly), Số tháng giảm, Số tiền giảm/tháng
    - Section 4 "Tiền phí dịch vụ": Nút "Thêm dịch vụ" → ServiceSelectionDialog, bảng DV đã chọn (tên, đồng hồ, chỉ số đầu, SL, đơn giá, xóa)
    - Create mode (contract undefined) vs Edit mode (contract pre-populated, contract_number readonly)
    - Gọi useCreateContract hoặc useUpdateContract on submit
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 3.1, 3.2, 3.3_

- [x] 10. Action dialogs
  - [x] 10.1 Tạo `src/components/contracts/RenewDialog.tsx`
    - React Hook Form + Zod (renewFormSchema)
    - Hiển thị ngày KT hiện tại (readonly), fields: Ngày KT mới, Giá thuê mới (default current), Tiền cọc mới (default current), Ghi chú
    - Gọi useRenewContract on submit
    - Chỉ available cho ACTIVE/EXPIRED contracts
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 10.2 Tạo `src/components/contracts/TransferRoomDialog.tsx`
    - React Hook Form + Zod (transferRoomFormSchema)
    - Hiển thị thông tin HĐ hiện tại, fields: Toà nhà mới, Phòng mới (chỉ AVAILABLE), Giường mới, Giá thuê mới, Ngày chuyển, Ghi chú
    - Cascading dropdown: building → room (AVAILABLE only) → bed
    - Gọi useTransferRoom on submit
    - Chỉ available cho ACTIVE contracts
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 10.3 Tạo `src/components/contracts/MoveOutDialog.tsx`
    - React Hook Form + Zod (moveOutFormSchema)
    - Fields: Ngày sẽ chuyển đi (required date picker), Ghi chú
    - Gọi useRegisterMoveOut on submit
    - Chỉ available cho ACTIVE contracts
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 10.4 Tạo `src/components/contracts/TransferContractDialog.tsx`
    - React Hook Form + Zod (transferContractFormSchema)
    - Hiển thị thông tin HĐ hiện tại, fields: Khách hàng mới (customer selection), Giá thuê mới, Tiền cọc mới, Ngày nhượng, Ghi chú
    - Embed CustomerSelectionDialog (single select mode) cho chọn khách mới
    - Gọi useTransferContract on submit
    - Chỉ available cho ACTIVE contracts
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 10.5 Tạo `src/components/contracts/TerminateDialog.tsx`
    - 2-step dialog: Step 1 chọn loại ("Khách bỏ cọc" / "Khách rời phòng")
    - Step 2a — Khách bỏ cọc: React Hook Form + Zod (terminateForfeitFormSchema), field Ngày bỏ cọc, nút "Lập hoá đơn & thanh lý"
    - Step 2b — Khách rời phòng: React Hook Form + Zod (terminateMoveOutFormSchema), 4 sections:
      - Thông tin HĐ (readonly): Mã HĐ, Khách hàng, Phòng, Ngày BĐ, Ngày KT, Ngày chuyển đi (required)
      - Công nợ khách hàng: bảng hoá đơn chưa TT (readonly, query unpaid invoices)
      - Hoàn cọc và tiền thừa: Tiền cọc hoàn trả, Phí phạt, Tiền phòng thừa
      - Tổng hợp: auto-calculated realtime (tổng công nợ, tổng cọc, tổng khấu trừ, số tiền quyết toán)
    - Gọi useTerminateForfeit hoặc useTerminateMoveOut on submit
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 10.6 Tạo `src/components/contracts/DeleteContractDialog.tsx`
    - Confirmation dialog "Bạn có chắc chắn muốn xóa hợp đồng này?"
    - Kiểm tra contract có invoices/termination records → hiển thị cảnh báo, chặn xóa
    - Gọi useDeleteContract on confirm
    - Chỉ available cho DRAFT hoặc contracts không có financial records
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 11. Checkpoint — Verify all dialogs
  - Ensure all action dialogs render and form validation works. Ask the user if questions arise.

- [x] 12. Import/Export Excel
  - [x] 12.1 Tạo `src/lib/contractExcelHelpers.ts`
    - Implement `exportContracts(contracts, filters)`: xuất Excel với cột Mã HĐ, Trạng thái, Vị trí, Khách hàng, SĐT, Giá thuê, Tiền cọc, Ngày BĐ, Ngày KT, Chu kỳ TT, Ghi chú
    - Implement `downloadContractImportTemplate()`: tải file mẫu Excel với cột Phòng, Giường, Tên KH, SĐT, CCCD, Ngày ký, Ngày BĐ, Ngày KT, Tiền thuê, Chu kỳ TT, Tiền cọc, Ghi chú
    - Implement `parseContractExcel(file, buildingId)`: parse file upload, validate required fields, return ImportResult<ContractImportRow> với success/failure details
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 12.1, 12.2_

  - [x] 12.2 Tạo `src/components/contracts/ContractImportExportDialog.tsx`
    - Mode 'import': Building selector dropdown + file upload area (drag-and-drop, .xlsx/.xls) + "Tải file mẫu tại đây" link + "Nhập dữ liệu" button
    - Mode 'export': Download Excel matching current filters
    - Import: parse file → validate → create contracts (batch) → show result dialog (success count + failed rows with errors)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2_

- [x] 13. Routing và wiring
  - [x] 13.1 Cập nhật routing trong `src/App.tsx`
    - Đảm bảo route `/contracts` trỏ đến ContractsPage mới
    - Verify navigation link trong sidebar/menu
    - _Requirements: 1.1_

- [x] 14. Checkpoint — Full integration test
  - Ensure all features work end-to-end: list page with stats/filters/table, create/edit contract, all action dialogs, import/export. Ask the user if questions arise.

- [x] 15. Property-based tests
  - [x] 15.1 Write property test: Contract display status computation
    - **Property 1: Contract display status computation**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 6.3**
    - Tạo `src/lib/__tests__/contractStatus.property.test.ts`
    - Dùng fast-check generate random contracts với various status, end_date, expected_move_out_date
    - Assert getContractDisplayStatus returns correct status cho mọi combination

  - [x] 15.2 Write property test: Contract stats computation
    - **Property 2: Contract stats computation and filtering consistency**
    - **Validates: Requirements 1.1, 1.2**
    - Thêm vào `src/lib/__tests__/contractStatus.property.test.ts`
    - Generate random contract lists, verify stats counts match filtered list lengths

  - [x] 15.3 Write property test: Contract filter correctness
    - **Property 3: Contract filter correctness**
    - **Validates: Requirements 1.4, 1.7, 15.2, 15.3, 15.4**
    - Tạo `src/lib/__tests__/contractFilters.property.test.ts`
    - Generate random contracts + filter combinations, verify filtered results match ALL filters

  - [x] 15.4 Write property test: Cascading dropdown filtering
    - **Property 4: Cascading dropdown filtering**
    - **Validates: Requirements 1.5, 1.6, 2.3**
    - Thêm vào `src/lib/__tests__/contractFilters.property.test.ts`
    - Generate random buildings/rooms/beds, verify cascading filter correctness

  - [x] 15.5 Write property test: Contract validation rejects invalid data
    - **Property 5: Contract validation rejects invalid data**
    - **Validates: Requirements 2.12**
    - Tạo `src/lib/__tests__/contractValidation.property.test.ts`
    - Generate invalid form data (missing room_id, empty dates, negative amounts, end < start), verify Zod rejects

  - [x] 15.6 Write property test: Contract representative uniqueness
    - **Property 7: Contract representative uniqueness**
    - **Validates: Requirements 2.6**
    - Thêm vào `src/lib/__tests__/contractValidation.property.test.ts`
    - Generate random customer lists, verify exactly one representative

  - [x] 15.7 Write property test: Deposit remaining calculation
    - **Property 8: Deposit remaining calculation**
    - **Validates: Requirements 2.8**
    - Thêm vào `src/lib/__tests__/contractValidation.property.test.ts`
    - Generate random total_deposit + deposit_paid, verify remaining = max(0, total - paid)

  - [x] 15.8 Write property test: Action button availability
    - **Property 9: Action button availability by contract status**
    - **Validates: Requirements 3.4, 4.4, 5.5, 6.4, 7.4, 10.4**
    - Tạo `src/lib/__tests__/contractOperations.property.test.ts`
    - Generate random contract statuses, verify button enabled/disabled states

  - [x] 15.9 Write property test: Termination settlement calculation
    - **Property 13: Termination settlement calculation**
    - **Validates: Requirements 8.3, 9.5, 9.6, 9.7**
    - Thêm vào `src/lib/__tests__/contractOperations.property.test.ts`
    - Generate random settlement values, verify formula: deposit_refund + excess_rent - outstanding_debt - penalty_fee

  - [x] 15.10 Write property test: Excel import row validation
    - **Property 15: Excel import row validation**
    - **Validates: Requirements 11.4, 11.5**
    - Tạo `src/lib/__tests__/contractImport.property.test.ts`
    - Generate random import rows (valid + invalid), verify acceptance/rejection

  - [x] 15.11 Write property test: Available rooms filter for transfer
    - **Property 16: Available rooms filter for transfer**
    - **Validates: Requirements 5.4**
    - Tạo `src/lib/__tests__/contractRoomFilter.property.test.ts`
    - Generate random rooms with various statuses, verify only AVAILABLE rooms shown

- [x] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project uses TypeScript, React, Supabase, TanStack Query, React Hook Form + Zod, shadcn/ui, Tailwind CSS
- Existing hooks (useContracts.ts) and components (src/components/contracts/) will be replaced/updated as needed
- All user-facing text in Vietnamese
