# Implementation Plan: Tái triển khai Module Toà nhà & Căn hộ

## Overview

Tái triển khai hoàn toàn module Toà nhà (Building) và Căn hộ (Room) bao gồm: database migration (bảng `building_services`, cột template cho `rooms`), TypeScript types, Zod validation, React hooks (`useBuildingServices` mới, cập nhật `useBuildings`/`useRooms`), UI components (shadcn/ui), pages (BuildingsPage full-page form, RoomsPage dialog form), quick-create building/floor, cascading address, toggle status, và delete guards. Triển khai theo thứ tự: database → types → validation → hooks → building module → room module → integration → tests.

## Tasks

- [x] 1. Database migration và TypeScript types
  - [x] 1.1 Tạo migration file `supabase/migrations/20250703000001_building_room_reimplementation.sql`
    - Tạo bảng `building_services` (id UUID PK, building_id FK, service_id FK, is_active BOOLEAN default true, unit_price_override DECIMAL(15,2) nullable, created_at, updated_at)
    - Thêm UNIQUE constraint `building_services(building_id, service_id)`
    - Thêm CHECK constraint `unit_price_override >= 0`
    - Tạo indexes: `idx_building_services_building_id`, `idx_building_services_service_id`
    - Enable RLS trên `building_services` với 4 policies (SELECT, INSERT, UPDATE, DELETE) kiểm tra user_id qua buildings table
    - Tạo trigger `update_building_services_updated_at` dùng function `update_updated_at_column()` hiện có
    - Thêm cột `invoice_template_id` (UUID FK → document_templates, ON DELETE SET NULL) và `lease_template_id` (UUID FK → document_templates, ON DELETE SET NULL) vào bảng `rooms`
    - Tạo indexes: `idx_rooms_invoice_template_id`, `idx_rooms_lease_template_id`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 1.2 Tạo `src/types/building.ts`
    - Định nghĩa types: BuildingStatus ('ACTIVE' | 'INACTIVE'), Building, BuildingWithRelations (kèm area và rooms_count), BuildingService, BuildingServiceWithDetails, BuildingFormData, BuildingServiceFormData
    - _Requirements: 9.1, 9.2, 2.2, 2.5, 2.6_

  - [x] 1.3 Tạo `src/types/room.ts`
    - Định nghĩa types: RoomStatus ('AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'MAINTENANCE' | 'UNAVAILABLE'), Room (kèm invoice_template_id, lease_template_id), RoomWithRelations, RoomFormData
    - _Requirements: 9.3, 6.4, 6.6, 6.7_

- [x] 2. Validation schemas
  - [x] 2.1 Tạo `src/lib/buildingValidation.ts`
    - Implement `buildingSchema` (Zod): name min 1, province min 1, district min 1, ward min 1, street_address min 1, code optional, area_id optional UUID, status enum ACTIVE/INACTIVE default ACTIVE
    - Implement `buildingServiceSchema` (Zod): service_id UUID, is_active boolean, unit_price_override number min 0 nullable
    - Export BuildingFormData type
    - Tất cả error messages bằng tiếng Việt
    - _Requirements: 12.1, 12.2, 12.8, 2.9, 2.10, 3.3_

  - [x] 2.2 Tạo `src/lib/roomValidation.ts`
    - Implement `roomSchema` (Zod): building_id UUID required, floor number int positive required, name min 1, rent_price number min 0, deposit_amount number min 0, area number positive nullable optional, max_occupants int positive nullable optional, status enum default AVAILABLE, invoice_template_id UUID nullable optional, lease_template_id UUID nullable optional
    - Export RoomFormData type
    - Tất cả error messages bằng tiếng Việt
    - _Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 6.9_

  - [ ]* 2.3 Write property tests cho building validation
    - **Property 4: Building validation rejects invalid data**
    - **Validates: Requirements 2.10, 3.3, 12.1, 12.2**
    - Tạo `src/__tests__/buildings/buildingValidation.test.ts`
    - Dùng fast-check generate building form data với required fields empty/whitespace, verify Zod rejects

  - [ ]* 2.4 Write property test cho building service validation
    - **Property 6: Building services loading and validation**
    - **Validates: Requirements 2.6, 9.5, 12.8**
    - Thêm vào `src/__tests__/buildings/buildingValidation.test.ts`
    - Dùng fast-check generate negative unit_price_override, verify rejection; verify uniqueness constraint logic

  - [ ]* 2.5 Write property tests cho room validation
    - **Property 9: Room validation rejects invalid data**
    - **Validates: Requirements 6.9, 7.3, 12.3, 12.4, 12.5, 12.6, 12.7**
    - Tạo `src/__tests__/rooms/roomValidation.test.ts`
    - Dùng fast-check generate room form data với invalid fields (empty name, negative rent_price, negative deposit_amount, non-positive area, non-positive max_occupants), verify Zod rejects

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. React hooks
  - [x] 4.1 Tạo `src/hooks/useBuildingServices.ts`
    - Implement `useBuildingServices(buildingId)` - query building_services kèm service details (name, unit_price, unit) cho một building
    - Implement `useUpsertBuildingServices()` - mutation batch upsert building_services (delete removed, upsert remaining) với invalidateQueries
    - Xử lý error codes: 23505 (duplicate building+service), 23503 (FK violation)
    - _Requirements: 2.6, 2.7, 9.2, 9.5_

  - [x] 4.2 Cập nhật `src/hooks/useBuildings.ts`
    - Cập nhật query để select kèm `area:areas(id, name, code)` và `rooms:rooms(count)` (chỉ rooms chưa deleted)
    - Thêm `useUpdateBuildingStatus()` - mutation riêng cho toggle status với optimistic update pattern
    - Đảm bảo `useDeleteBuilding()` kiểm tra rooms count trước khi soft-delete, reject nếu có rooms chưa deleted
    - _Requirements: 1.2, 1.6, 1.7, 4.1, 4.2, 4.3, 11.1, 11.2_

  - [x] 4.3 Cập nhật `src/hooks/useRooms.ts`
    - Cập nhật query để select kèm `invoice_template_id`, `lease_template_id`, và `building:buildings(id, name, code, area_id)`
    - Thêm/đảm bảo `useUpdateRoomStatus()` - mutation cho toggle status (AVAILABLE ↔ UNAVAILABLE)
    - _Requirements: 5.4, 6.4, 6.6, 6.7, 7.1, 7.2, 8.2, 8.3, 11.3_

- [x] 5. Building list page và components
  - [x] 5.1 Tạo `src/components/buildings/BuildingStatsCards.tsx`
    - 3 thẻ Card: "Tất cả toà nhà" (tổng), "Đang hoạt động" (ACTIVE, icon/border xanh), "Ngừng hoạt động" (INACTIVE, icon/border đỏ)
    - Props: total, active, inactive
    - _Requirements: 1.2_

  - [x] 5.2 Tạo `src/components/buildings/BuildingListFilters.tsx`
    - Tìm kiếm (search input theo tên, mã, địa chỉ), Trạng thái hoạt động (dropdown: Tất cả/Đang hoạt động/Ngừng hoạt động), Khu vực (dropdown danh sách areas)
    - _Requirements: 1.3, 1.4_

  - [x] 5.3 Tạo `src/components/buildings/BuildingListTable.tsx`
    - Bảng với cột: Mã (code), Thao tác (nút sửa xanh, xoá đỏ, in), Tên toà nhà, Địa chỉ, Số căn hộ (count + link "Xem" navigate tới `/rooms?building_id={id}`), Ngày TT (created_at/updated_at), Hoạt động (shadcn Switch toggle)
    - Props: buildings, onEdit, onDelete, onToggleStatus, onViewRooms
    - _Requirements: 1.6, 1.7, 5.5_

  - [x] 5.4 Tái triển khai `src/components/buildings/DeleteBuildingDialog.tsx`
    - Dialog xác nhận xoá, kiểm tra rooms_count > 0 → hiển thị cảnh báo "Không thể xóa tòa nhà đang có N căn hộ" và disable nút xoá
    - Soft-delete qua useDeleteBuilding, toast "Dữ liệu đã được XOÁ thành công"
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 5.5 Tái triển khai `src/pages/buildings/BuildingsPage.tsx`
    - Breadcrumb "Danh mục dữ liệu > Toà nhà"
    - Compose: BuildingStatsCards + BuildingListFilters + Toolbar (nút + Thêm, Search, Refresh, Grid/List toggle) + BuildingListTable + DeleteBuildingDialog
    - State: searchTerm, statusFilter, areaFilter, deleteDialogOpen, selectedBuilding
    - Client-side filtering: search (name, code, street_address case-insensitive), status, area_id
    - Stats computed từ filtered data
    - Nút (+) navigate tới `/buildings/new`
    - Nút sửa navigate tới `/buildings/:id/edit`
    - Toggle hoạt động gọi useUpdateBuildingStatus
    - Link "Xem" căn hộ navigate tới `/rooms?building_id={id}`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 11.1, 11.2, 11.4_

  - [ ]* 5.6 Write property tests cho building stats và filters
    - **Property 1: Building stats consistency**
    - **Validates: Requirements 1.2, 11.4**
    - **Property 2: Building filter correctness**
    - **Validates: Requirements 1.4**
    - Tạo `src/__tests__/buildings/buildingStats.test.ts` và `src/__tests__/buildings/buildingFilters.test.ts`
    - Dùng fast-check generate random building lists, verify total = active + inactive; generate filter combinations, verify filtered results match ALL filters

- [x] 6. Building form page và components
  - [x] 6.1 Tạo `src/components/buildings/BuildingAddressSection.tsx`
    - Cascading dropdowns: Tỉnh/Thành phố → Quận/Huyện → Xã/Phường, Khu vực (dropdown areas), Địa chỉ chi tiết (text input)
    - Dùng `useProvinces`, `useDistricts`, `useWards` từ `useAddressData.ts` hiện có
    - Reset Quận + Phường khi thay đổi Tỉnh; reset Phường khi thay đổi Quận
    - Props: control, setValue, watch (từ React Hook Form)
    - _Requirements: 2.3, 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 6.2 Tạo `src/components/buildings/BuildingServicesSection.tsx`
    - Bảng dịch vụ: cột Sử dụng (Switch toggle), Tên dịch vụ (text), Đơn giá (number input, placeholder = giá mặc định từ services)
    - Load danh sách services hiện có qua `useServices` hook
    - Nút (+) thêm dịch vụ mới nhanh
    - Props: services (BuildingServiceFormData[]), onChange, onAddService
    - _Requirements: 2.5, 2.6, 2.7_

  - [x] 6.3 Tạo `src/components/buildings/BuildingForm.tsx`
    - React Hook Form + Zod resolver (buildingSchema)
    - Sections: Tiêu đề "TOÀ NHÀ", Thông tin cơ bản (Tên toà nhà *, Mã toà), BuildingAddressSection, Toggle Hoạt động (mặc định BẬT), BuildingServicesSection
    - Nút Lưu + Huỷ bỏ
    - Props: defaultValues, buildingId (edit mode → load building_services), onSubmit, isSubmitting
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 2.11_

  - [x] 6.4 Tạo `src/pages/buildings/BuildingFormPage.tsx`
    - Route `/buildings/new` (create) và `/buildings/:id/edit` (edit)
    - Load existing building data + building_services khi edit mode
    - Submit: createBuilding → upsertBuildingServices (2-step), hoặc updateBuilding → upsertBuildingServices
    - Toast "Dữ liệu đã được TẠO thành công" / "Dữ liệu đã được CẬP NHẬT thành công"
    - Huỷ bỏ → navigate back
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3_

  - [ ]* 6.5 Write property tests cho building toggle và round-trip
    - **Property 3: Building status toggle round-trip**
    - **Validates: Requirements 1.7, 11.1, 11.2**
    - **Property 5: Building create-read round-trip**
    - **Validates: Requirements 2.9, 3.1, 3.2, 12.9**
    - Tạo `src/__tests__/buildings/buildingToggle.test.ts` và `src/__tests__/buildings/buildingRoundTrip.test.ts`

  - [ ]* 6.6 Write property tests cho building delete
    - **Property 7: Building soft-delete exclusion**
    - **Validates: Requirements 4.2**
    - **Property 8: Building delete guard with active rooms**
    - **Validates: Requirements 4.3**
    - Tạo `src/__tests__/buildings/buildingDelete.test.ts`

  - [ ]* 6.7 Write property tests cho cascading address
    - **Property 14: Cascading address filtering**
    - **Validates: Requirements 13.2, 13.3**
    - **Property 15: Cascading address reset on parent change**
    - **Validates: Requirements 13.4, 13.5**
    - Tạo `src/__tests__/shared/addressCascading.test.ts`

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Room list page và components
  - [x] 8.1 Tạo `src/components/rooms/RoomListFilters.tsx`
    - Tìm kiếm (search input theo tên phòng, mã), Toà nhà (dropdown), Tầng (dropdown cascading theo toà nhà đã chọn), Trạng thái hoạt động (dropdown)
    - Props: searchTerm, buildingFilter, floorFilter, statusFilter, buildings, floors, và các onChange handlers
    - _Requirements: 5.2_

  - [x] 8.2 Tạo `src/components/rooms/RoomListTable.tsx`
    - Bảng với cột: Tên phòng, Toà nhà, Tầng, Diện tích, Giá thuê, Tiền cọc, Số khách tối đa, Hoạt động (Switch toggle)
    - Cột Thao tác: nút sửa, xoá
    - Props: rooms, onEdit, onDelete, onToggleStatus
    - _Requirements: 5.4, 11.3_

  - [x] 8.3 Tái triển khai `src/components/rooms/DeleteRoomDialog.tsx`
    - Dialog xác nhận xoá căn hộ
    - Soft-delete qua useDeleteRoom, toast "Dữ liệu đã được XOÁ thành công"
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 8.4 Tái triển khai `src/pages/rooms/RoomsPage.tsx`
    - Breadcrumb "Danh mục dữ liệu > Căn hộ"
    - Compose: RoomListFilters + Toolbar (nút + Thêm, Search, Refresh, Grid/List toggle) + RoomListTable + RoomFormDialog + DeleteRoomDialog
    - State: searchTerm, buildingFilter, floorFilter, statusFilter, createDialogOpen, editDialogOpen, deleteDialogOpen, selectedRoom
    - Hỗ trợ URL query param `?building_id=xxx` để pre-filter khi navigate từ BuildingsPage
    - Toggle hoạt động gọi useUpdateRoomStatus (AVAILABLE ↔ UNAVAILABLE)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 11.3, 11.4_

- [x] 9. Room form dialog và quick-create
  - [x] 9.1 Tạo `src/components/rooms/QuickCreateBuildingDialog.tsx`
    - Dialog nhỏ: Tên toà nhà (*), Mã toà (optional)
    - Tạo building với status ACTIVE
    - onCreated callback → auto-select trong parent dropdown
    - _Requirements: 10.1, 10.2_

  - [x] 9.2 Tạo `src/components/rooms/QuickCreateFloorDialog.tsx`
    - Dialog nhỏ: Số tầng (*), Tên tầng (optional)
    - Requires buildingId prop
    - onCreated callback → auto-select trong parent dropdown
    - _Requirements: 10.3, 10.4, 10.5_

  - [x] 9.3 Tạo `src/components/rooms/RoomFormDialog.tsx`
    - Dialog thêm/sửa căn hộ, React Hook Form + Zod (roomSchema)
    - Fields: Toà nhà (* dropdown ACTIVE buildings + "Thêm toà nhà" → QuickCreateBuildingDialog), Tầng (* dropdown cascading theo toà nhà + "Thêm tầng" → QuickCreateFloorDialog), Tên phòng (*), Tiền thuê (*), Tiền cọc (*), Diện tích (optional), Số khách tối đa (optional), Toggle Hoạt động (mặc định BẬT), Mẫu hoá đơn (dropdown từ useDocumentTemplatesByType('invoice')), Mẫu hợp đồng thuê (dropdown từ useDocumentTemplatesByType('lease_contract'))
    - Create mode: useCreateRoom, toast "Dữ liệu đã được TẠO thành công"
    - Edit mode: load existing room data, useUpdateRoom, toast "Dữ liệu đã được CẬP NHẬT thành công"
    - Xử lý duplicate room name error (23505) → toast "Tên phòng đã tồn tại trong toà nhà này"
    - Props: open, onOpenChange, room (undefined = create), preselectedBuildingId
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.2, 7.3_

  - [ ]* 9.4 Write property tests cho room toggle và round-trip
    - **Property 10: Room create-read round-trip**
    - **Validates: Requirements 6.8, 7.1, 7.2, 12.10**
    - **Property 12: Room status toggle**
    - **Validates: Requirements 11.3**
    - Tạo `src/__tests__/rooms/roomRoundTrip.test.ts` và `src/__tests__/rooms/roomToggle.test.ts`

  - [ ]* 9.5 Write property tests cho room uniqueness và delete
    - **Property 11: Room name uniqueness per building**
    - **Validates: Requirements 6.10**
    - **Property 13: Room soft-delete and count update**
    - **Validates: Requirements 8.2, 8.3**
    - Tạo `src/__tests__/rooms/roomUniqueness.test.ts` và `src/__tests__/rooms/roomDelete.test.ts`

  - [ ]* 9.6 Write property test cho floor cascading
    - **Property 16: Floor dropdown cascading by building**
    - **Validates: Requirements 6.3**
    - Tạo `src/__tests__/shared/floorCascading.test.ts`

- [x] 10. Routing và integration
  - [x] 10.1 Cập nhật React Router configuration
    - Thêm/cập nhật routes: `/buildings` (BuildingsPage), `/buildings/new` (BuildingFormPage create), `/buildings/:id/edit` (BuildingFormPage edit), `/rooms` (RoomsPage)
    - Đảm bảo navigation từ sidebar menu Danh mục dữ liệu → Toà nhà / Căn hộ
    - _Requirements: 1.1, 5.1_

  - [x] 10.2 Wire navigation giữa buildings và rooms
    - Link "Xem" từ BuildingListTable cột Số căn hộ → navigate tới `/rooms?building_id={id}`
    - RoomsPage đọc `building_id` từ URL query param và pre-filter
    - _Requirements: 1.6, 5.5_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1-16)
- Sử dụng fast-check cho property-based testing, vitest cho unit tests
- Tất cả components dùng shadcn/ui, form dùng React Hook Form + Zod, data fetching dùng TanStack React Query v5
- Building form dùng full-page pattern (không dialog) vì form phức tạp; Room form dùng dialog pattern
- Cascading address dùng hook `useAddressData` hiện có
- Document templates dùng hook `useDocumentTemplatesByType` hiện có
