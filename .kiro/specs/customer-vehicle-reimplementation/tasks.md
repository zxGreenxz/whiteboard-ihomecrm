# Implementation Plan: Customer & Vehicle Module Reimplementation

## Overview

Tái triển khai hoàn toàn module Khách hàng (Customer) và Phương tiện (Vehicle) bao gồm: database migration, TypeScript types, Zod validation, React hooks (TanStack Query), UI components (shadcn/ui), pages, CT01 form, và Excel import/export. Triển khai theo thứ tự: database → types → validation → hooks → shared components → customer module → vehicle module → CT01 module → import/export → tests.

## Tasks

- [x] 1. Database migration và schema setup
  - [x] 1.1 Tạo migration file `supabase/migrations/20250701000001_customer_vehicle_reimplementation.sql`
    - Thêm `ELECTRIC_BIKE` vào `vehicle_type` enum
    - Tạo `customer_status_v2` enum (RENTING, MOVED_OUT, WALK_IN)
    - Thêm cột `status_v2` vào bảng `customers` với migration dữ liệu cũ
    - Thêm các cột tổ chức vào `customers`: company_name, tax_code, representative, business_registration_url, headquarters_address
    - Thêm các cột mới vào `vehicles`: customer_id (FK), vehicle_name, owner_name, ticket_number, building_id (FK), room_id (FK), image_url
    - Tạo indexes cho vehicles (customer_id, building_id, room_id, vehicle_name, owner_name, full-text search)
    - Tạo bảng `ct01_declarations` với đầy đủ cột, indexes, RLS policies, và trigger updated_at
    - Thêm constraint cho customers: full_name NOT empty, phone format 10-11 chữ số
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

- [x] 2. TypeScript types và Zod validation schemas
  - [x] 2.1 Tạo `src/types/customer.ts`
    - Định nghĩa types: CustomerType, CustomerStatus, StatFilterType, Customer, CustomerFilters, CustomerStats, CustomerFormData, InlineVehicle, CT01Declaration, CT01FamilyMember, CT01FormData
    - _Requirements: 11.1, 2.1, 2.3, 3.1, 4.2, 6.2_

  - [x] 2.2 Tạo `src/types/vehicle.ts`
    - Định nghĩa types: VehicleType, Vehicle, VehicleWithRelations, VehicleFilters, VehicleFormData, VehicleImportRow
    - _Requirements: 11.2, 8.3, 9.3_

  - [x] 2.3 Tạo `src/lib/customerValidation.ts`
    - Implement customerIndividualSchema, customerOrganizationSchema, customerSchema (discriminatedUnion trên customer_type)
    - Validate: full_name min 1, phone regex 10-11 digits, email optional valid format
    - _Requirements: 2.10, 2.11, 3.2, 3.3, 13.1, 13.2, 13.3_

  - [x] 2.4 Tạo `src/lib/vehicleValidation.ts`
    - Implement vehicleSchema: vehicle_type enum, vehicle_name min 1, color min 1, license_plate min 1, owner_name min 1
    - Implement imageValidation: accepted formats PNG/JPG/JPEG, max 10MB
    - _Requirements: 9.5, 9.6, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [x] 2.5 Tạo `src/lib/ct01Validation.ts`
    - Implement ct01Schema: registration_authority, full_name, date_of_birth, gender, id_number required; family_members array
    - _Requirements: 6.2, 6.5_

  - [ ]* 2.6 Write property tests cho customer validation
    - **Property 4: Customer validation rejects invalid data**
    - **Validates: Requirements 2.11, 3.3, 11.7, 13.1, 13.2, 13.3**
    - Tạo `src/lib/__tests__/customerValidation.test.ts`
    - Dùng fast-check generate invalid full_name (empty/whitespace), invalid phone (not 10-11 digits), invalid email

  - [ ]* 2.7 Write property tests cho valid customer creation
    - **Property 5: Valid customer creation succeeds with correct type**
    - **Validates: Requirements 2.10, 3.2**
    - Thêm vào `src/lib/__tests__/customerValidation.test.ts`
    - Dùng fast-check generate valid individual (full_name + phone) và organization (company_name + phone) data

  - [ ]* 2.8 Write property tests cho vehicle validation
    - **Property 11: Vehicle validation rejects invalid data**
    - **Validates: Requirements 9.6, 13.4, 13.5, 13.6, 13.7**
    - Tạo `src/lib/__tests__/vehicleValidation.test.ts`
    - Dùng fast-check generate invalid vehicle_name, color, license_plate, owner_name (empty/whitespace)

  - [ ]* 2.9 Write property test cho image upload validation
    - **Property 15: Image upload validation**
    - **Validates: Requirements 13.8**
    - Thêm vào `src/lib/__tests__/vehicleValidation.test.ts`
    - Dùng fast-check generate files with various MIME types và sizes

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. React hooks cho Customer module
  - [x] 4.1 Tái triển khai `src/hooks/useCustomers.ts`
    - Implement useCustomers(filters, pagination) - query với status_v2, statFilter, area/building/room/bed filters, search, pagination
    - Implement useCustomer(id) - single customer query
    - Implement useCustomerStats(filters) - count total, individual, organization, foreign
    - Implement useCreateCustomer() - insert mutation với invalidateQueries
    - Implement useUpdateCustomer() - update mutation với invalidateQueries
    - Implement useDeleteCustomer() - soft-delete (set deleted_at) mutation
    - Xử lý error codes: 23505 (duplicate phone/id_number), 23503 (FK violation)
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.9, 2.10, 2.12, 5.2, 5.4_

  - [x] 4.2 Tạo `src/hooks/useAddressData.ts`
    - Implement useProvinces(), useDistricts(provinceCode), useWards(districtCode)
    - Load từ static JSON data (dữ liệu hành chính VN)
    - _Requirements: 2.5_

- [x] 5. React hooks cho Vehicle và CT01 modules
  - [x] 5.1 Tái triển khai `src/hooks/useVehicles.ts`
    - Implement useVehicles(filters, pagination) - query với search, vehicle_type, building_id, customer_id, join customer/building/room
    - Implement useVehicle(id) - single vehicle query
    - Implement useCreateVehicle() - insert mutation
    - Implement useUpdateVehicle() - update mutation
    - Implement useDeleteVehicle() - soft-delete mutation
    - _Requirements: 8.2, 8.3, 8.5, 9.5, 9.8, 12.2_

  - [x] 5.2 Tạo `src/hooks/useCT01Declarations.ts`
    - Implement useCT01Declarations(customerId) - query declarations cho customer
    - Implement useCreateCT01Declaration() - insert mutation
    - _Requirements: 6.5_

- [x] 6. Shared components
  - [x] 6.1 Tạo `src/components/customers/ImageUploadZone.tsx`
    - Upload zone với drag & drop, preview, accept PNG/JPG/JPEG, max 10MB
    - Upload tới Supabase Storage (customer-images / vehicle-images bucket)
    - Props: label, value (current URL), onChange, accept, maxSizeMB
    - _Requirements: 2.2, 9.2, 13.8_

  - [x] 6.2 Tạo `src/components/customers/AddressCascadingDropdowns.tsx`
    - 3 cascading dropdowns: Tỉnh/TP → Quận/Huyện → Xã/Phường
    - Reset child khi parent thay đổi
    - Dùng useAddressData hook
    - _Requirements: 2.5_

- [x] 7. Customer list page và components
  - [x] 7.1 Tạo `src/components/customers/CustomerStatusTabs.tsx`
    - 3 tabs: Đang thuê (RENTING), Đã chuyển đi (MOVED_OUT), Khách vãng lai (WALK_IN)
    - Tab Đang thuê mặc định active
    - _Requirements: 1.1_

  - [x] 7.2 Tạo `src/components/customers/CustomerStatsCards.tsx`
    - 4 thẻ thống kê: Tất cả, Cá nhân, Doanh nghiệp, Khách nước ngoài
    - Click thẻ để lọc danh sách
    - Nhận stats data từ useCustomerStats
    - _Requirements: 1.2, 1.3_

  - [x] 7.3 Tạo `src/components/customers/CustomerListFilters.tsx`
    - Cascading dropdowns: Khu vực → Toà nhà → Phòng → Giường
    - _Requirements: 1.4, 1.5_

  - [x] 7.4 Tạo `src/components/customers/CustomerListToolbar.tsx`
    - Search input, nút Thêm (+), Export, Import, Print, View toggle (Grid/List)
    - _Requirements: 1.6, 1.8_

  - [x] 7.5 Tạo `src/components/customers/CustomerListTable.tsx`
    - Bảng với cột: Mã KH, Thao tác (Xem/Sửa/Xoá), Khách hàng (tên + avatar), Căn hộ, CMND/CCCD, Ngày sinh, Địa chỉ
    - Pagination
    - _Requirements: 1.7_

  - [x] 7.6 Tái triển khai `src/pages/customers/CustomersPage.tsx`
    - Compose: CustomerStatusTabs + CustomerStatsCards + CustomerListFilters + CustomerListToolbar + CustomerListTable + CustomerDetailModal
    - State management cho activeTab, activeStatFilter, filters, searchQuery, pagination
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ]* 7.7 Write property tests cho customer filtering, search, stats
    - **Property 1: Customer stat filter consistency**
    - **Validates: Requirements 1.2, 1.3, 1.9**
    - **Property 2: Customer search returns matching results**
    - **Validates: Requirements 1.6**
    - **Property 3: Customer filter updates list and stats**
    - **Validates: Requirements 1.5**
    - Tạo `src/lib/__tests__/customerFilters.test.ts`
    - Dùng fast-check generate customer lists, filter combinations, search queries

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Customer form (thêm/sửa)
  - [x] 9.1 Tạo `src/components/customers/CustomerIndividualFields.tsx`
    - Fields cho cá nhân: Họ tên, SĐT, Email, CMND/CCCD, Ngày cấp, Nơi cấp, Ngày sinh, Giới tính
    - Toggle Khách nước ngoài với fields bổ sung
    - _Requirements: 2.3, 2.4_

  - [x] 9.2 Tạo `src/components/customers/CustomerOrganizationFields.tsx`
    - Fields cho tổ chức: Tên công ty, SĐT, Email, Mã số thuế, Người đại diện, Địa chỉ trụ sở
    - _Requirements: 3.1_

  - [x] 9.3 Tạo `src/components/customers/CustomerVehiclesSection.tsx`
    - Inline vehicle list: thêm/xoá phương tiện với fields Loại PT, Tên dòng xe, Biển số
    - _Requirements: 2.9_

  - [x] 9.4 Tạo `src/components/customers/CustomerForm.tsx`
    - React Hook Form + Zod resolver
    - Toggle Cá nhân/Tổ chức, conditional rendering CustomerIndividualFields hoặc CustomerOrganizationFields
    - Sections: Image upload (4 zones), Thông tin chung, Địa chỉ (AddressCascadingDropdowns), Tài chính & Liên lạc, Nhóm KH + Ghi chú, Thông tin xe (CustomerVehiclesSection)
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 9.5 Tạo `src/pages/customers/CustomerFormPage.tsx`
    - Route `/customers/new` (create) và `/customers/:id/edit` (edit)
    - Load existing data khi edit mode
    - Submit qua useCreateCustomer / useUpdateCustomer
    - Toast success/error messages
    - _Requirements: 2.10, 2.11, 2.12, 5.1, 5.2_

- [x] 10. Customer detail modal và actions
  - [x] 10.1 Tạo `src/components/customers/CustomerDetailModal.tsx`
    - Dialog hiển thị: thông tin cá nhân, ảnh CCCD, địa chỉ, bảng phương tiện
    - Actions: Sao chép (clipboard), Sửa (navigate to edit), Xoá (confirm dialog)
    - Link CT01
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [x] 10.2 Implement xoá khách hàng với xác nhận
    - Confirm dialog, cảnh báo nếu có hợp đồng hiệu lực
    - Soft-delete qua useDeleteCustomer
    - Toast "Dữ liệu đã được XOÁ thành công"
    - _Requirements: 5.3, 5.4, 5.5_

- [x] 11. Vehicle module (page, components, form)
  - [x] 11.1 Tạo `src/components/vehicles/VehicleListToolbar.tsx`
    - Nút Thêm (+), Export, Import, Print, View toggle
    - _Requirements: 8.4_

  - [x] 11.2 Tạo `src/components/vehicles/VehicleListTable.tsx`
    - Bảng: Mã PT, Thao tác (Sửa/Xoá), Thông tin xe (loại + tên + biển số + màu), Khách hàng (tên + SĐT), Vị trí (toà nhà + phòng)
    - Pagination
    - _Requirements: 8.3, 8.5_

  - [x] 11.3 Tạo `src/components/vehicles/VehicleFormDialog.tsx`
    - Dialog thêm/sửa phương tiện
    - React Hook Form + Zod (vehicleSchema)
    - Fields: Image upload, Loại PT, Tên dòng xe, Màu xe, Biển số, Tên chủ xe, Số vé xe, Toà nhà (dropdown), Phòng (cascading theo toà nhà), Khách hàng (dropdown)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 11.4 Tái triển khai `src/pages/vehicles/VehiclesPage.tsx`
    - Breadcrumb "Khách hàng > Phương tiện"
    - Search bar + VehicleListToolbar + VehicleListTable + VehicleFormDialog
    - State: searchQuery, pagination, dialog open/close, selectedVehicle
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 11.5 Implement xoá phương tiện
    - Confirm dialog + soft-delete qua useDeleteVehicle
    - Toast "Dữ liệu đã được XOÁ thành công"
    - Cập nhật danh sách sau xoá
    - _Requirements: 12.1, 12.2, 12.3_

  - [ ]* 11.6 Write property tests cho vehicle search và cascading filter
    - **Property 10: Vehicle search returns matching results**
    - **Validates: Requirements 8.2**
    - **Property 14: Room cascading filter by building**
    - **Validates: Requirements 9.4**
    - Tạo `src/lib/__tests__/vehicleFilters.test.ts`

- [ ] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. CT01 module (tờ khai thay đổi thông tin cư trú)
  - [x] 13.1 Tạo `src/lib/ct01Helpers.ts`
    - Implement autoFillCT01FromCustomer(customer): CT01FormData - map customer fields sang CT01 fields
    - _Requirements: 6.3_

  - [x] 13.2 Tạo `src/components/customers/CT01Form.tsx`
    - React Hook Form + Zod (ct01Schema)
    - Auto-fill từ customer data
    - Fields theo mẫu quy định: Cơ quan ĐKCT, Họ tên, Ngày sinh, Giới tính, CMND/CCCD, SĐT, Email, Nơi thường trú, Nơi tạm trú, Nơi ở hiện tại, Nghề nghiệp, Chủ hộ, Quan hệ, Nội dung đề nghị
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 13.3 Tạo `src/components/customers/CT01FamilyMembersTable.tsx`
    - Bảng thành viên gia đình: STT, Họ tên, Ngày sinh, Giới tính, CMND/CCCD, Nghề nghiệp, Quan hệ với người khai, Quan hệ với chủ hộ
    - Thêm/xoá dòng
    - _Requirements: 6.4_

  - [x] 13.4 Tạo `src/components/customers/CT01PrintLayout.tsx`
    - Layout in ấn khổ A4 theo mẫu quy định nhà nước
    - CSS @media print styling
    - _Requirements: 6.7_

  - [x] 13.5 Tạo `src/pages/customers/CT01FormPage.tsx`
    - Route `/customers/:id/ct01`
    - Compose CT01Form + CT01FamilyMembersTable + CT01PrintLayout
    - Lưu qua useCreateCT01Declaration, sau đó window.print()
    - _Requirements: 6.1, 6.5, 6.6_

  - [ ]* 13.6 Write property test cho CT01 auto-fill
    - **Property 8: CT01 auto-fill from customer data**
    - **Validates: Requirements 6.3**
    - Tạo `src/lib/__tests__/ct01Helpers.test.ts`
    - Dùng fast-check generate customer data, verify auto-fill mapping

- [x] 14. Excel import/export
  - [x] 14.1 Tạo `src/lib/customerExcelHelpers.ts`
    - Implement exportCustomers(customers, filters) - xuất Excel theo bộ lọc hiện tại
    - Implement downloadCustomerImportTemplate() - tải file mẫu với cột bắt buộc đánh dấu (*)
    - Implement parseCustomerExcel(file) - đọc và validate từng dòng, trả về ImportResult với valid rows và per-row errors
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 14.2 Tạo `src/lib/vehicleExcelHelpers.ts`
    - Implement exportVehicles(vehicles) - xuất Excel
    - Implement downloadVehicleImportTemplate() - tải file mẫu
    - Implement parseVehicleExcel(file) - đọc và validate từng dòng
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 14.3 Tạo `src/components/customers/CustomerImportExportDialog.tsx`
    - Dialog import: link tải file mẫu, upload zone, nút Nhập dữ liệu
    - Hiển thị lỗi per-row nếu có
    - _Requirements: 7.2, 7.3, 7.4, 7.6_

  - [x] 14.4 Tạo `src/components/vehicles/VehicleImportExportDialog.tsx`
    - Dialog import: link tải file mẫu, upload zone, nút Nhập dữ liệu
    - Hiển thị lỗi per-row nếu có
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

  - [ ]* 14.5 Write property tests cho customer Excel import/export
    - **Property 9: Customer Excel import validates rows correctly**
    - **Validates: Requirements 7.4, 7.6**
    - **Property 17: Customer Excel export round-trip**
    - **Validates: Requirements 7.1**
    - Tạo `src/lib/__tests__/customerExcelHelpers.test.ts`

  - [ ]* 14.6 Write property tests cho vehicle Excel import
    - **Property 16: Vehicle Excel import validates rows correctly**
    - **Validates: Requirements 10.3, 10.5**
    - Tạo `src/lib/__tests__/vehicleExcelHelpers.test.ts`

- [x] 15. Routing và integration
  - [x] 15.1 Cập nhật React Router configuration
    - Thêm routes: `/customers` (CustomersPage), `/customers/new` (CustomerFormPage create), `/customers/:id/edit` (CustomerFormPage edit), `/customers/:id/ct01` (CT01FormPage), `/vehicles` (VehiclesPage)
    - Đảm bảo navigation từ sidebar menu Quản lý & Vận hành → Khách hàng → Khách hàng / Phương tiện
    - _Requirements: 1.1, 8.1_

  - [x] 15.2 Wire print functionality
    - Implement print cho danh sách khách hàng (CustomerListToolbar)
    - Implement print cho danh sách phương tiện (VehicleListToolbar)
    - CSS @media print cho cả hai danh sách
    - _Requirements: 1.8, 8.4_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1-17)
- Sử dụng fast-check cho property-based testing, vitest cho unit tests
- Tất cả components dùng shadcn/ui, form dùng React Hook Form + Zod, data fetching dùng TanStack React Query v5
