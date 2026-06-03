# IMPLEMENTATION PLAN - CHI TIẾT TỪNG PHASE
## CRM - Hệ thống quản lý bất động sản

---

## 📊 TỔNG QUAN

### Trạng thái hiện tại
- **Code**: 1% - Chỉ có boilerplate với React + TypeScript + Vite
- **Documentation**: 99% - Đã có ~12,124 dòng tài liệu chi tiết
- **Database**: 0% - Chưa có bảng nào, chỉ có design
- **Features**: 0% - Chưa có tính năng nào hoạt động

### Mục tiêu
Xây dựng hệ thống quản lý bất động sản đầy đủ tính năng theo docs.resident.vn với:
- 30+ database tables
- 100+ React components
- 150+ API endpoints
- 19 loại báo cáo
- Tự động hóa hoàn chỉnh

### Chiến lược chia nhỏ
- **Tổng số phases**: 20 phases
- **Mỗi phase**: 2-5 ngày (tùy độ phức tạp)
- **Tổng thời gian**: 10-14 tuần (~2.5-3.5 tháng)
- **Phương pháp**: Bottom-up (Foundation → Core Features → Advanced)

---

## 🎯 DANH SÁCH 20 PHASES

| Phase | Tên | Mô tả | Thời gian | Độ ưu tiên |
|-------|-----|-------|-----------|------------|
| **P1** | Database Foundation | Tạo schema, enums, functions | 3 ngày | Critical |
| **P2** | Authentication System | Đăng ký, đăng nhập, RLS | 3 ngày | Critical |
| **P3** | Main Layout & Navigation | Header, Sidebar, Routing | 2 ngày | Critical |
| **P4** | Areas Management | CRUD khu vực | 2 ngày | High |
| **P5** | Buildings Management | CRUD tòa nhà + Import Excel | 3 ngày | High |
| **P6** | Rooms Management | CRUD phòng + Bulk actions | 3 ngày | High |
| **P7** | Beds Management | CRUD giường (KTX) | 2 ngày | Medium |
| **P8** | Services Management | Quản lý dịch vụ 4 loại | 2 ngày | High |
| **P9** | Tenants Management | Quản lý khách thuê | 2 ngày | High |
| **P10** | Lead & Deposit | Khách hẹn + Đặt cọc | 3 ngày | High |
| **P11** | Contracts - Create/View | Tạo HĐ + Chi tiết | 4 ngày | Critical |
| **P12** | Contracts - Lifecycle | Gia hạn, chuyển phòng, thanh lý | 3 ngày | Critical |
| **P13** | Meter Readings | Ghi chỉ số điện nước | 2 ngày | High |
| **P14** | Invoices System | Tạo, duyệt, in hóa đơn | 4 ngày | Critical |
| **P15** | Payments & Cash Book | Thu tiền + Sổ quỹ | 3 ngày | Critical |
| **P16** | Asset & Vehicle Management | Tài sản + Phương tiện | 3 ngày | Medium |
| **P17** | Issues & Tasks | Sự cố + Phân công công việc | 3 ngày | Medium |
| **P18** | Dashboard & Building Map | Bảng tin + Sơ đồ tòa nhà | 3 ngày | High |
| **P19** | Reports System | 19 loại báo cáo + Export | 4 ngày | High |
| **P20** | Notifications & Settings | Thông báo + Cài đặt + Polish | 4 ngày | Medium |

**Tổng: 10-14 tuần**

---

## 📝 CHI TIẾT TỪNG PHASE

---

## PHASE 1: DATABASE FOUNDATION (3 ngày)
**Mục tiêu**: Tạo toàn bộ database schema trên Supabase

### Deliverables
- ✅ 30+ database tables
- ✅ 20+ enum types
- ✅ RLS policies cho tất cả tables
- ✅ Triggers & Functions
- ✅ Indexes cho performance
- ✅ Sample seed data

### Tasks Checklist
```
Database Setup:
□ Setup Supabase project
□ Configure connection strings
□ Setup .env file với Supabase credentials

Migration 1 - Extensions & Enums:
□ Enable uuid-ossp extension
□ Create 20+ enum types (building_status, room_status, contract_status...)
□ Test enums

Migration 2 - Core Tables (Part 1):
□ profiles table + RLS
□ areas table + RLS
□ buildings table + RLS
□ rooms table + RLS
□ beds table + RLS
□ Test foreign key relationships

Migration 3 - Core Tables (Part 2):
□ services table + RLS
□ tenants table + RLS
□ deposits table + RLS
□ vehicles table + RLS
□ Test data insertion

Migration 4 - Contract Tables:
□ contracts table + RLS
□ contract_services table + RLS
□ Test complex joins

Migration 5 - Billing Tables:
□ invoices table + RLS
□ invoice_items table + RLS
□ payments table + RLS
□ meter_readings table + RLS
□ Test calculation logic

Migration 6 - Asset & Issue Tables:
□ asset_categories table + RLS
□ suppliers table + RLS
□ assets table + RLS
□ asset_handovers table + RLS
□ asset_movements table + RLS
□ asset_maintenance table + RLS
□ issue_categories table + RLS
□ issues table + RLS
□ issue_comments table + RLS

Migration 7 - Advanced Tables:
□ leads table + RLS
□ lead_activities table + RLS
□ expenses table + RLS
□ settings table + RLS
□ signature_templates table + RLS
□ code_sequences table + RLS
□ notification_templates table + RLS
□ notifications table + RLS
□ notification_logs table + RLS

Triggers & Functions:
□ update_updated_at_column() function
□ Apply trigger to all tables with updated_at
□ update_building_total_rooms() function
□ update_asset_status_on_contract_change() function
□ generate_invoice_number() function
□ generate_contract_number() function
□ generate_code() function (generic)
□ update_invoice_paid_amount() function
□ create_profile_for_new_user() function

Testing:
□ Test RLS policies với multiple users
□ Test triggers hoạt động đúng
□ Test foreign key constraints
□ Seed sample data (1 building, 5 rooms, 2 tenants)
□ Verify indexes được tạo
```

### Files Changed
```
supabase/migrations/
├── 001_extensions_and_enums.sql
├── 002_core_tables_part1.sql
├── 003_core_tables_part2.sql
├── 004_contract_tables.sql
├── 005_billing_tables.sql
├── 006_asset_issue_tables.sql
├── 007_advanced_tables.sql
├── 008_triggers_functions.sql
└── 009_seed_data.sql
```

### Testing Checklist
```
□ Tất cả tables được tạo thành công
□ RLS policies hoạt động (user A không thấy data của user B)
□ Triggers tự động update updated_at
□ Foreign keys prevent invalid deletes
□ Enums chỉ chấp nhận giá trị hợp lệ
□ Indexes tối ưu query performance
□ Sample data insert thành công
```

### Success Criteria
- Supabase dashboard hiển thị 30+ tables
- Sample queries chạy < 50ms
- RLS test pass 100%

---

## PHASE 2: AUTHENTICATION SYSTEM (3 ngày)
**Mục tiêu**: Implement đầy đủ authentication flow

### Deliverables
- ✅ Register page
- ✅ Login page
- ✅ Forgot password page
- ✅ Protected routes
- ✅ Session management
- ✅ Auth hooks

### Tasks Checklist
```
Setup:
□ Configure Supabase Auth settings
□ Setup auth redirect URLs
□ Configure email templates

Pages:
□ src/pages/auth/Register.tsx
  □ Form với full_name, email, phone, password
  □ Zod validation schema
  □ Supabase signup call
  □ Show success/error messages
  □ Redirect to login sau khi đăng ký
□ src/pages/auth/Login.tsx
  □ Form với email/phone + password
  □ Remember me checkbox
  □ Supabase login call
  □ Redirect to dashboard
□ src/pages/auth/ForgotPassword.tsx
  □ Form với email
  □ Send reset email
  □ Confirmation message

Hooks:
□ src/hooks/useAuth.ts
  □ useAuth() - get current user
  □ useLogin() - login mutation
  □ useLogout() - logout mutation
  □ useRegister() - register mutation
  □ useSession() - get session
□ src/hooks/useProfile.ts
  □ useProfile() - get user profile
  □ useUpdateProfile() - update profile

Components:
□ src/components/auth/ProtectedRoute.tsx
  □ Check auth state
  □ Redirect to login if not authenticated
□ src/components/auth/PublicRoute.tsx
  □ Redirect to dashboard if already authenticated

Routing:
□ Update App.tsx với auth routes
□ Implement route guards
□ Handle auth state changes

Testing:
□ Test đăng ký user mới
□ Test login với email
□ Test login với phone
□ Test logout
□ Test forgot password
□ Test protected routes redirect
□ Test remember me
□ Test session persistence
```

### Files Changed
```
src/
├── pages/auth/
│   ├── Register.tsx
│   ├── Login.tsx
│   └── ForgotPassword.tsx
├── hooks/
│   ├── useAuth.ts
│   └── useProfile.ts
├── components/auth/
│   ├── ProtectedRoute.tsx
│   └── PublicRoute.tsx
├── lib/
│   └── supabase.ts (update)
└── App.tsx (update routes)
```

### Testing Checklist
```
Đăng ký:
□ Valid data → success
□ Duplicate email → error
□ Invalid email format → validation error
□ Weak password → validation error
□ Profile auto-created

Đăng nhập:
□ Correct credentials → success + redirect
□ Wrong password → error
□ Non-existent email → error
□ Remember me → session persists

Forgot Password:
□ Valid email → reset email sent
□ Invalid email → error shown
□ Reset link works

Protected Routes:
□ Not authenticated → redirect to login
□ Authenticated → can access
□ Session expired → redirect to login
```

### Success Criteria
- User có thể đăng ký, đăng nhập, logout
- Protected routes chỉ accessible khi authenticated
- Session persistence works across page refresh

---

## PHASE 3: MAIN LAYOUT & NAVIGATION (2 ngày)
**Mục tiêu**: Tạo layout chính và navigation system

### Deliverables
- ✅ Header component với user menu
- ✅ Sidebar với navigation menu
- ✅ Main layout wrapper
- ✅ Breadcrumbs
- ✅ Responsive design

### Tasks Checklist
```
Components:
□ src/components/layout/Header.tsx
  □ Logo
  □ User avatar dropdown
  □ Logout button
  □ Notifications icon (placeholder)
□ src/components/layout/Sidebar.tsx
  □ Navigation menu items
  □ Collapsible sections
  □ Active state highlighting
  □ Mobile responsive (drawer)
□ src/components/layout/MainLayout.tsx
  □ Combine Header + Sidebar
  □ Content area
  □ Footer (optional)
□ src/components/layout/Breadcrumbs.tsx
  □ Dynamic breadcrumb từ route
  □ Click to navigate

Navigation Structure:
□ Dashboard (/)
□ Danh mục dữ liệu
  □ Khu vực (/areas)
  □ Tòa nhà (/buildings)
  □ Phòng (/rooms)
  □ Giường (/beds)
  □ Dịch vụ (/services)
□ Khách hàng
  □ Khách hẹn (/leads)
  □ Đặt cọc (/deposits)
  □ Hợp đồng (/contracts)
  □ Khách thuê (/tenants)
  □ Phương tiện (/vehicles)
□ Tài chính
  □ Ghi chỉ số (/meter-readings)
  □ Hóa đơn (/invoices)
  □ Thu chi (/payments)
  □ Sổ quỹ (/cash-book)
□ Tài sản & Sự cố
  □ Tài sản (/assets)
  □ Sự cố (/issues)
□ Báo cáo
  □ Báo cáo BĐS (/reports/real-estate)
  □ Báo cáo tài chính (/reports/finance)
  □ Báo cáo công việc (/reports/tasks)
□ Cài đặt
  □ Cài đặt chung (/settings/general)
  □ Mẫu biểu (/settings/templates)
  □ Mẫu chữ ký (/settings/signatures)
  □ Nhân viên (/settings/staff)

Routing:
□ Update App.tsx với tất cả routes
□ Placeholder pages cho mỗi route
□ 404 page

Styling:
□ Responsive design (Mobile, Tablet, Desktop)
□ Dark mode toggle (optional)
□ Consistent spacing & colors
```

### Files Changed
```
src/
├── components/layout/
│   ├── Header.tsx
│   ├── Sidebar.tsx
│   ├── MainLayout.tsx
│   ├── Breadcrumbs.tsx
│   └── NavLink.tsx (update)
├── pages/
│   ├── Dashboard.tsx
│   └── NotFound.tsx (update)
└── App.tsx (major update)
```

### Testing Checklist
```
Layout:
□ Header hiển thị đúng
□ Sidebar toggle works (mobile)
□ User menu dropdown works
□ Logout button works
□ Layout responsive trên mobile

Navigation:
□ Click menu item → navigate đúng route
□ Active menu item được highlight
□ Breadcrumbs hiển thị đúng
□ Nested menu expand/collapse

Responsive:
□ Mobile (< 768px) - Sidebar as drawer
□ Tablet (768px - 1024px) - Collapsed sidebar
□ Desktop (> 1024px) - Full sidebar
```

### Success Criteria
- Navigation hoàn chỉnh với 20+ routes
- Layout responsive trên mọi device
- User có thể navigate qua tất cả pages

---

## PHASE 4: AREAS MANAGEMENT (2 ngày)
**Mục tiêu**: CRUD khu vực (cấp quản lý cao nhất)

### Deliverables
- ✅ Areas list page với table
- ✅ Create area dialog
- ✅ Edit area dialog
- ✅ Delete area confirmation
- ✅ Search & filter

### Tasks Checklist
```
Hooks:
□ src/hooks/useAreas.ts
  □ useAreas() - fetch list
  □ useCreateArea() - create mutation
  □ useUpdateArea() - update mutation
  □ useDeleteArea() - soft delete mutation

Components:
□ src/pages/areas/AreasPage.tsx
  □ Table với columns: Code, Tên, Mô tả, Số tòa nhà, Trạng thái, Actions
  □ Search box
  □ Filter by status
  □ "Tạo khu vực" button
  □ Pagination
□ src/components/areas/CreateAreaDialog.tsx
  □ Form: name (required), code (optional), description, status
  □ Validation với Zod
  □ Submit button
□ src/components/areas/EditAreaDialog.tsx
  □ Pre-fill existing data
  □ Same form fields
□ src/components/areas/DeleteAreaDialog.tsx
  □ Confirmation message
  □ Warn if area có tòa nhà

Features:
□ Real-time updates (Supabase Realtime)
□ Optimistic updates
□ Error handling
□ Success toasts
```

### Files Changed
```
src/
├── pages/areas/
│   └── AreasPage.tsx
├── components/areas/
│   ├── CreateAreaDialog.tsx
│   ├── EditAreaDialog.tsx
│   └── DeleteAreaDialog.tsx
└── hooks/
    └── useAreas.ts
```

### Testing Checklist
```
CRUD:
□ Create area → success
□ Edit area → updates correctly
□ Delete area (không có tòa nhà) → success
□ Delete area (có tòa nhà) → warning

UI:
□ Table hiển thị areas
□ Search works
□ Filter by status works
□ Pagination works
□ Dialogs open/close đúng

Validation:
□ Empty name → error
□ Duplicate code → error (db constraint)
```

### Success Criteria
- User có thể CRUD areas hoàn chỉnh
- UI/UX mượt mà, không lag
- Data real-time sync

---

## PHASE 5: BUILDINGS MANAGEMENT (3 ngày)
**Mục tiêu**: CRUD tòa nhà + Import Excel

### Deliverables
- ✅ Buildings list page
- ✅ Create building form (multi-step)
- ✅ Edit building
- ✅ Delete building
- ✅ Import buildings từ Excel

### Tasks Checklist
```
Hooks:
□ src/hooks/useBuildings.ts
  □ useBuildings() - với nested select area
  □ useCreateBuilding()
  □ useUpdateBuilding()
  □ useDeleteBuilding()
  □ useImportBuildings() - bulk insert

Components:
□ src/pages/buildings/BuildingsPage.tsx
  □ Table: Khu vực, Tên tòa, Địa chỉ, Loại hình, Số phòng, Trạng thái, Actions
  □ Search by name, address
  □ Filter by area, type, status
  □ "Tạo tòa nhà" button
  □ "Import Excel" button
□ src/components/buildings/CreateBuildingDialog.tsx
  □ Step 1: Thông tin cơ bản (Area, Name, Code, Type)
  □ Step 2: Địa chỉ (Province, District, Ward, Street)
  □ Step 3: Cấu hình (Floors, Description, Amenities)
  □ Step 4: Ảnh (Upload images)
□ src/components/buildings/EditBuildingDialog.tsx
  □ Same form, pre-filled
□ src/components/buildings/ImportBuildingsDialog.tsx
  □ Download template button
  □ Upload Excel file
  □ Preview data
  □ Import button

Features:
□ Auto-calculate total_rooms
□ Image upload to Supabase Storage
□ Excel import với validation
```

### Files Changed
```
src/
├── pages/buildings/
│   └── BuildingsPage.tsx
├── components/buildings/
│   ├── CreateBuildingDialog.tsx
│   ├── EditBuildingDialog.tsx
│   ├── DeleteBuildingDialog.tsx
│   └── ImportBuildingsDialog.tsx
├── hooks/
│   └── useBuildings.ts
└── lib/
    ├── excel.ts (helper for Excel)
    └── storage.ts (update for images)
```

### Testing Checklist
```
CRUD:
□ Create building → success
□ Edit building → updates
□ Delete building (no rooms) → success
□ Delete building (có rooms) → error or cascade

Import Excel:
□ Download template
□ Upload valid file → import success
□ Upload invalid file → show errors
□ Preview shows correct data

Images:
□ Upload image → stored in Storage
□ Delete image → removed from Storage
```

### Success Criteria
- Buildings CRUD hoàn chỉnh
- Import Excel hoạt động tốt
- Images upload/delete smoothly

---

## PHASE 6: ROOMS MANAGEMENT (3 ngày)
**Mục tiêu**: CRUD phòng + Bulk actions

### Deliverables
- ✅ Rooms list page (group by building)
- ✅ Create room
- ✅ Edit room
- ✅ Delete room
- ✅ Bulk create rooms
- ✅ Change room status

### Tasks Checklist
```
Hooks:
□ src/hooks/useRooms.ts
  □ useRooms(building_id?) - filter by building
  □ useCreateRoom()
  □ useUpdateRoom()
  □ useDeleteRoom()
  □ useBulkCreateRooms()

Components:
□ src/pages/rooms/RoomsPage.tsx
  □ Filter by building (dropdown)
  □ Group rooms by floor
  □ Table: Tên phòng, Tầng, Diện tích, Giá thuê, Giá cọc, Trạng thái, Actions
  □ Search rooms
  □ "Tạo phòng" button
  □ "Tạo hàng loạt" button
□ src/components/rooms/CreateRoomDialog.tsx
  □ Building selector
  □ Name, Floor, Area
  □ Rent price, Deposit
  □ Max occupants
  □ Amenities checkboxes
□ src/components/rooms/EditRoomDialog.tsx
□ src/components/rooms/BulkCreateRoomsDialog.tsx
  □ Building selector
  □ Start floor, End floor
  □ Rooms per floor
  □ Naming pattern (e.g., {floor}01, {floor}02)
  □ Default rent price, deposit
  □ Preview before create

Features:
□ Quick status change (AVAILABLE → OCCUPIED)
□ Room detail view
□ Images upload
```

### Files Changed
```
src/
├── pages/rooms/
│   ├── RoomsPage.tsx
│   └── RoomDetailPage.tsx
├── components/rooms/
│   ├── CreateRoomDialog.tsx
│   ├── EditRoomDialog.tsx
│   ├── BulkCreateRoomsDialog.tsx
│   └── RoomCard.tsx
└── hooks/
    └── useRooms.ts
```

### Testing Checklist
```
CRUD:
□ Create room → success
□ Edit room → updates
□ Delete room → success
□ Bulk create 10 rooms → all created

UI:
□ Filter by building works
□ Group by floor displays correctly
□ Search works
□ Status change button works

Bulk Create:
□ Preview shows correct room names
□ Validation works (duplicate names)
□ Progress indicator during bulk insert
```

### Success Criteria
- Rooms CRUD hoàn chỉnh
- Bulk create tiết kiệm thời gian
- UI hiển thị rooms theo tầng

---

## PHASE 7: BEDS MANAGEMENT (2 ngày)
**Mục tiêu**: CRUD giường (cho KTX/Sleepbox)

### Deliverables
- ✅ Beds list page (nested under room)
- ✅ Create bed
- ✅ Edit bed
- ✅ Delete bed

### Tasks Checklist
```
Hooks:
□ src/hooks/useBeds.ts
  □ useBeds(room_id)
  □ useCreateBed()
  □ useUpdateBed()
  □ useDeleteBed()

Components:
□ src/pages/beds/BedsPage.tsx
  □ Filter by building → room
  □ Table: Tên giường, Giá thuê, Giá cọc, Trạng thái, Actions
  □ "Tạo giường" button
□ src/components/beds/CreateBedDialog.tsx
  □ Room selector (only show DORMITORY/SLEEPBOX type)
  □ Name, Rent price, Deposit
□ src/components/beds/EditBedDialog.tsx

Features:
□ Only available for building type = DORMITORY or SLEEPBOX
□ Hide beds menu if no DORMITORY buildings
```

### Files Changed
```
src/
├── pages/beds/
│   └── BedsPage.tsx
├── components/beds/
│   ├── CreateBedDialog.tsx
│   └── EditBedDialog.tsx
└── hooks/
    └── useBeds.ts
```

### Testing Checklist
```
CRUD:
□ Create bed → success
□ Edit bed → updates
□ Delete bed → success

UI:
□ Filter by room works
□ Only rooms from DORMITORY buildings shown
```

### Success Criteria
- Beds CRUD hoàn chỉnh
- Logic ẩn/hiện đúng cho loại building

---

## PHASE 8: SERVICES MANAGEMENT (2 ngày)
**Mục tiêu**: Quản lý dịch vụ (4 loại)

### Deliverables
- ✅ Services list page
- ✅ Create service (4 types)
- ✅ Edit service
- ✅ Delete service

### Tasks Checklist
```
Hooks:
□ src/hooks/useServices.ts
  □ useServices()
  □ useCreateService()
  □ useUpdateService()
  □ useDeleteService()

Components:
□ src/pages/services/ServicesPage.tsx
  □ Group by type (tabs)
  □ Table: Tên, Loại, Đơn giá, Đơn vị, Mặc định, Actions
  □ "Tạo dịch vụ" button
□ src/components/services/CreateServiceDialog.tsx
  □ Name, Type (4 options)
  □ Unit price, Unit
  □ Is default, Is mandatory
  □ Type-specific fields:
    - FIXED: Nothing extra
    - PER_PERSON: Nothing extra
    - PER_ROOM: Nothing extra
    - METER_READING: Show "Unit" as required (kWh, m3)

Features:
□ Default services (Điện, Nước, Wifi, Vệ sinh)
□ Color coding by type
```

### Files Changed
```
src/
├── pages/services/
│   └── ServicesPage.tsx
├── components/services/
│   ├── CreateServiceDialog.tsx
│   └── EditServiceDialog.tsx
└── hooks/
    └── useServices.ts
```

### Testing Checklist
```
CRUD:
□ Create each service type → success
□ Edit service → updates
□ Delete service (not used) → success
□ Delete service (used in contracts) → error

UI:
□ Tabs switch between service types
□ Default services auto-selected in contract form
```

### Success Criteria
- Services CRUD hoàn chỉnh
- 4 types đều hoạt động đúng

---

## PHASE 9: TENANTS MANAGEMENT (2 ngày)
**Mục tiêu**: Quản lý khách thuê

### Deliverables
- ✅ Tenants list page
- ✅ Create tenant
- ✅ Edit tenant
- ✅ View tenant detail (history)

### Tasks Checklist
```
Hooks:
□ src/hooks/useTenants.ts
  □ useTenants()
  □ useTenant(id) - with contracts history
  □ useCreateTenant()
  □ useUpdateTenant()
  □ useDeleteTenant()

Components:
□ src/pages/tenants/TenantsPage.tsx
  □ Table: Họ tên, SĐT, Email, CCCD, Trạng thái, Actions
  □ Search by name, phone
  □ Filter by status
  □ "Tạo khách thuê" button
□ src/pages/tenants/TenantDetailPage.tsx
  □ Thông tin cá nhân
  □ Lịch sử hợp đồng
  □ Lịch sử thanh toán
  □ Ghi chú
□ src/components/tenants/CreateTenantDialog.tsx
  □ Personal info: Full name, DOB, Gender, ID type, ID number
  □ Contact: Phone, Email
  □ Address: Permanent address
  □ Emergency contact
  □ Upload ID images (front/back)

Features:
□ Search suggestion khi gõ tên/SĐT
□ Click tenant → view detail
```

### Files Changed
```
src/
├── pages/tenants/
│   ├── TenantsPage.tsx
│   └── TenantDetailPage.tsx
├── components/tenants/
│   ├── CreateTenantDialog.tsx
│   └── EditTenantDialog.tsx
└── hooks/
    └── useTenants.ts
```

### Testing Checklist
```
CRUD:
□ Create tenant → success
□ Edit tenant → updates
□ Delete tenant (no contracts) → success
□ Delete tenant (có contracts) → error

UI:
□ Search works
□ Filter by status works
□ Tenant detail shows all info

Upload:
□ ID images upload → success
```

### Success Criteria
- Tenants CRUD hoàn chỉnh
- Tenant detail informative

---

## PHASE 10: LEAD & DEPOSIT (3 ngày)
**Mục tiêu**: Khách hẹn + Đặt cọc

### Deliverables
- ✅ Leads management (B1 → B4)
- ✅ Deposits management
- ✅ Convert deposit → contract

### Tasks Checklist
```
Hooks:
□ src/hooks/useLeads.ts
  □ useLeads()
  □ useCreateLead()
  □ useUpdateLead()
  □ useConvertLeadToDeposit()
□ src/hooks/useDeposits.ts
  □ useDeposits()
  □ useCreateDeposit()
  □ useUpdateDeposit()
  □ useConvertDepositToContract() - link to Phase 11

Components - Leads:
□ src/pages/leads/LeadsPage.tsx
  □ Kanban board: B1 Bắn khách | B2 Hẹn khách | B3 Tư vấn | Converted | Failed
  □ Drag & drop to change status
  □ "Tạo khách hẹn" button
□ src/components/leads/CreateLeadDialog.tsx
  □ Customer info: Name, Phone, Email
  □ Source (dropdown)
  □ Building/Room interested
  □ Appointment date/time
  □ Assign staff
  □ Notes

Components - Deposits:
□ src/pages/deposits/DepositsPage.tsx
  □ Table: Khách, Phòng, Số tiền, Ngày cọc, Giữ đến ngày, Trạng thái, Actions
  □ Filter by status
□ src/components/deposits/CreateDepositDialog.tsx
  □ Tenant selector (or create new)
  □ Room/Bed selector
  □ Amount
  □ Deposit date
  □ Hold until date
□ src/components/deposits/ConvertToContractDialog.tsx
  □ Confirm conversion
  □ Link to create contract (Phase 11)

Features:
□ Kanban board for leads
□ Auto update room status when deposit CONFIRMED
□ Notification when hold_until approaching
```

### Files Changed
```
src/
├── pages/leads/
│   └── LeadsPage.tsx
├── pages/deposits/
│   └── DepositsPage.tsx
├── components/leads/
│   ├── CreateLeadDialog.tsx
│   ├── LeadCard.tsx (for Kanban)
│   └── LeadDetailDialog.tsx
├── components/deposits/
│   ├── CreateDepositDialog.tsx
│   └── ConvertToContractDialog.tsx
└── hooks/
    ├── useLeads.ts
    └── useDeposits.ts
```

### Testing Checklist
```
Leads:
□ Create lead → B1
□ Drag to B2 → updates status
□ Convert to deposit → creates deposit record

Deposits:
□ Create deposit → room status = RESERVED
□ Confirm deposit → status = CONFIRMED
□ Convert to contract → navigate to contract form
□ Refund deposit → amount returned
□ Forfeit deposit → amount lost
```

### Success Criteria
- Leads Kanban hoạt động mượt
- Deposit → Contract flow seamless

---

## PHASE 11: CONTRACTS - CREATE/VIEW (4 ngày)
**Mục tiêu**: Tạo hợp đồng + Xem chi tiết

### Deliverables
- ✅ Contracts list page
- ✅ Create contract (multi-step)
- ✅ Contract detail page (full info)
- ✅ Print contract (PDF)

### Tasks Checklist
```
Hooks:
□ src/hooks/useContracts.ts
  □ useContracts()
  □ useContract(id) - with nested data
  □ useCreateContract()
  □ usePrintContract(id)

Components:
□ src/pages/contracts/ContractsPage.tsx
  □ Table: Số HĐ, Khách thuê, Phòng, Ngày bắt đầu, Ngày kết thúc, Trạng thái, Actions
  □ Filter by status, building
  □ Search by contract number, tenant name
  □ "Tạo hợp đồng" button
□ src/pages/contracts/CreateContractPage.tsx (multi-step form)
  □ Step 1: Chọn khách thuê (existing or create new)
  □ Step 2: Chọn phòng/giường (only AVAILABLE)
  □ Step 3: Thông tin hợp đồng (Signed date, Start date, End date, Payment cycle)
  □ Step 4: Tài chính (Rent price, Total deposit, Deposit paid, Discounts JSONB)
  □ Step 5: Dịch vụ (Select services, override unit price, initial meter readings)
  □ Step 6: Xác nhận (Review all info)
□ src/pages/contracts/ContractDetailPage.tsx
  □ Tab "Thông tin chung": All fields
  □ Tab "Dịch vụ": contract_services list
  □ Tab "Hóa đơn": invoices của HĐ này
  □ Tab "Thanh toán": payments history
  □ Tab "Lịch sử": contract changes log
  □ Actions: Gia hạn, Chuyển phòng, Nhượng HĐ, Thanh lý (Phase 12)

Features:
□ Auto-calculate deposit_remaining
□ Auto-generate contract_number
□ Initial meter readings → meter_readings table
□ Update room/bed status → OCCUPIED
□ Print contract to PDF (using template)
```

### Files Changed
```
src/
├── pages/contracts/
│   ├── ContractsPage.tsx
│   ├── CreateContractPage.tsx
│   └── ContractDetailPage.tsx
├── components/contracts/
│   ├── ContractForm.tsx (multi-step)
│   ├── ContractServicesTable.tsx
│   ├── ContractInvoicesTable.tsx
│   └── PrintContractDialog.tsx
└── hooks/
    └── useContracts.ts
```

### Testing Checklist
```
Create Contract:
□ All 6 steps complete successfully
□ Validation works on each step
□ Can go back/forward
□ Submit creates contract + contract_services + meter_readings
□ Room status → OCCUPIED
□ Contract number auto-generated

Contract Detail:
□ All tabs display correct data
□ Nested data loaded (tenant, room, services)

Print:
□ PDF generates với đầy đủ thông tin
□ Template variables replaced correctly
```

### Success Criteria
- User có thể tạo contract hoàn chỉnh
- Contract detail hiển thị đầy đủ
- PDF export works

---

## PHASE 12: CONTRACTS - LIFECYCLE (3 ngày)
**Mục tiêu**: Gia hạn, chuyển phòng, nhượng HĐ, thanh lý

### Deliverables
- ✅ Extend contract
- ✅ Transfer room
- ✅ Transfer contract (to new tenant)
- ✅ Terminate contract (settlement)

### Tasks Checklist
```
Hooks:
□ src/hooks/useContracts.ts (continue)
  □ useExtendContract()
  □ useTransferRoom()
  □ useTransferContract()
  □ useTerminateContract()

Components:
□ src/components/contracts/ExtendContractDialog.tsx
  □ Current end date
  □ Extend months (input)
  □ New end date (calculated)
  □ New rent price (optional update)
  □ Submit → creates new contract with parent_contract_id
  □ Old contract status → EXTENDED
□ src/components/contracts/TransferRoomDialog.tsx
  □ Current room
  □ New room selector (AVAILABLE only)
  □ Transfer date
  □ New rent price
  □ Submit → terminate old contract, create new contract
□ src/components/contracts/TransferContractDialog.tsx
  □ Current tenant
  □ New tenant selector
  □ Transfer date
  □ Keep same room & rent
  □ Submit → old contract → TRANSFERRED, new contract created
□ src/components/contracts/TerminateContractDialog.tsx
  □ Reason: Rời phòng / Bỏ cọc
  □ Actual end date
  □ Tính toán settlement:
    - Công nợ cũ (unpaid invoices)
    - Tiền phòng chưa trả (prorated if < 1 month)
    - Hoàn trả cọc (total_deposit - penalties)
    - Phí phạt/hư hỏng (input)
    - **Kết quả**: Thu thêm XX VND hoặc Trả lại XX VND
  □ Submit → contract status = TERMINATED, room/bed status = AVAILABLE

Features:
□ Settlement calculation logic
□ Auto-create final invoice for unpaid rent
□ Prevent terminate if có công nợ (option)
```

### Files Changed
```
src/
├── components/contracts/
│   ├── ExtendContractDialog.tsx
│   ├── TransferRoomDialog.tsx
│   ├── TransferContractDialog.tsx
│   └── TerminateContractDialog.tsx
└── hooks/
    └── useContracts.ts (add mutations)
```

### Testing Checklist
```
Extend:
□ Calculate new end date correctly
□ Create new contract
□ Old contract status → EXTENDED

Transfer Room:
□ Old contract → TERMINATED
□ New contract created with new room
□ New room status → OCCUPIED
□ Old room status → AVAILABLE

Transfer Contract:
□ Old contract → TRANSFERRED
□ New contract created with new tenant
□ Same room, same services

Terminate:
□ Settlement calculation correct
□ Unpaid invoices included
□ Deposit refund correct
□ Room status → AVAILABLE
```

### Success Criteria
- Tất cả 4 actions hoạt động đúng
- Settlement calculation chính xác
- Room/bed status updated đúng

---

## PHASE 13: METER READINGS (2 ngày)
**Mục tiêu**: Ghi chỉ số điện nước

### Deliverables
- ✅ Meter readings page (by contract)
- ✅ Bulk record readings
- ✅ View history

### Tasks Checklist
```
Hooks:
□ src/hooks/useMeterReadings.ts
  □ useMeterReadings(contract_id)
  □ useCreateMeterReading()
  □ useBulkCreateMeterReadings()

Components:
□ src/pages/meter-readings/MeterReadingsPage.tsx
  □ List active contracts
  □ For each contract: Điện (kWh), Nước (m3)
  □ Input new reading
  □ Auto-calculate consumption
  □ "Lưu" button for each contract
  □ "Lưu tất cả" button (bulk)
□ src/components/meter-readings/MeterReadingHistoryDialog.tsx
  □ Table: Ngày ghi, Chỉ số cũ, Chỉ số mới, Tiêu thụ
  □ Chart: Tiêu thụ theo tháng

Features:
□ Validate: new reading >= previous reading
□ Auto-get previous reading from last record
□ Bulk record for all contracts at once (đầu tháng)
```

### Files Changed
```
src/
├── pages/meter-readings/
│   └── MeterReadingsPage.tsx
├── components/meter-readings/
│   └── MeterReadingHistoryDialog.tsx
└── hooks/
    └── useMeterReadings.ts
```

### Testing Checklist
```
Record:
□ Input new reading → consumption calculated
□ New reading < old → validation error
□ Save → creates meter_reading record

Bulk:
□ Record for multiple contracts at once
□ Skip contracts without meter services

History:
□ Show all readings for a contract
□ Chart displays trend
```

### Success Criteria
- Meter readings CRUD hoàn chỉnh
- Bulk record saves time
- History informative

---

## PHASE 14: INVOICES SYSTEM (4 ngày)
**Mục tiêu**: Tạo, duyệt, in hóa đơn

### Deliverables
- ✅ Invoices list page
- ✅ Auto-generate invoices (bulk)
- ✅ Manual create invoice
- ✅ Approve invoice (single/bulk)
- ✅ Invoice detail
- ✅ Print invoice (PDF/Thermal)

### Tasks Checklist
```
Hooks:
□ src/hooks/useInvoices.ts
  □ useInvoices()
  □ useInvoice(id)
  □ useCreateInvoice()
  □ useAutoGenerateInvoices() - for all active contracts
  □ useApproveInvoice()
  □ useBulkApproveInvoices()
  □ usePrintInvoice()

Components:
□ src/pages/invoices/InvoicesPage.tsx
  □ Table: Số HĐ, Khách thuê, Kỳ thanh toán, Tổng tiền, Đã thu, Còn lại, Trạng thái, Actions
  □ Filter by status, month
  □ "Tạo hóa đơn tự động" button
  □ "Tạo hóa đơn thủ công" button
  □ "Duyệt hàng loạt" button (multi-select)
□ src/pages/invoices/CreateInvoicePage.tsx
  □ Select contract
  □ Billing period (start, end)
  □ Auto-calculate:
    - Rent (prorated if < 1 month)
    - Services (from contract_services)
    - Meter readings (get latest consumption × unit_price)
    - Previous debt
    - Discount
    - Total
  □ Invoice items table (editable)
  □ Submit → creates invoice + invoice_items
□ src/pages/invoices/InvoiceDetailPage.tsx
  □ Invoice info
  □ Invoice items table
  □ Payments list
  □ Actions: Approve, Print, Email (future)

Features:
□ Auto-generate logic:
  - Loop all active contracts
  - Get billing period (e.g., 01/12 → 31/12)
  - Calculate rent + services + meter readings + debt - discount
  - Create invoice + items
  - Set due_date = issue_date + payment_due_days (from settings)
□ Approve:
  - Status: DRAFT → APPROVED
  - Send notification (future)
□ Print:
  - PDF format (A4)
  - Thermal format (80mm)
  - Include QR code for payment (future)
```

### Files Changed
```
src/
├── pages/invoices/
│   ├── InvoicesPage.tsx
│   ├── CreateInvoicePage.tsx
│   └── InvoiceDetailPage.tsx
├── components/invoices/
│   ├── AutoGenerateInvoicesDialog.tsx
│   ├── ApproveInvoiceDialog.tsx
│   ├── InvoiceItemsTable.tsx
│   └── PrintInvoiceDialog.tsx
└── hooks/
    └── useInvoices.ts
```

### Testing Checklist
```
Auto-generate:
□ Generates for all active contracts
□ Calculations correct (rent + services + meter)
□ Invoice items created
□ Due date calculated

Manual create:
□ Can create for specific contract
□ Can edit invoice items
□ Total calculated correctly

Approve:
□ Single approve works
□ Bulk approve works
□ Status changes to APPROVED

Print:
□ PDF generates correctly
□ Thermal print format works
□ All data displayed
```

### Success Criteria
- Auto-generate invoices works flawlessly
- Invoice detail comprehensive
- Print formats work well

---

## PHASE 15: PAYMENTS & CASH BOOK (3 ngày)
**Mục tiêu**: Thu tiền + Sổ quỹ

### Deliverables
- ✅ Payments page (collect payment)
- ✅ Payment receipt print
- ✅ Cash book page
- ✅ Cash flow report

### Tasks Checklist
```
Hooks:
□ src/hooks/usePayments.ts
  □ usePayments()
  □ useCreatePayment()
  □ usePaymentReceipt(id)
□ src/hooks/useCashBook.ts
  □ useCashBook(start_date, end_date)
  □ useCashFlow(month)

Components:
□ src/pages/payments/PaymentsPage.tsx
  □ Table: Ngày thu, Số phiếu thu, Khách, Hóa đơn, Số tiền, Phương thức, Actions
  □ "Thu tiền" button
  □ Filter by date range, payment method
□ src/components/payments/CollectPaymentDialog.tsx
  □ Select invoice (show unpaid/partial paid only)
  □ Show: Total, Paid, Remaining
  □ Input: Amount, Payment method, Payment date
  □ Notes
  □ Submit → creates payment, updates invoice.paid_amount, invoice.status
□ src/components/payments/PaymentReceiptDialog.tsx
  □ Print receipt (PDF)
  □ Info: Receipt number, Date, Tenant, Amount, Method
□ src/pages/cash-book/CashBookPage.tsx
  □ Date range picker
  □ Table: Ngày, Loại (Thu/Chi), Mô tả, Số tiền, Số dư
  □ Summary: Số dư đầu, Tổng thu, Tổng chi, Số dư cuối
□ src/pages/cash-flow/CashFlowPage.tsx
  □ Month picker
  □ Chart: Thu vs Chi by day
  □ Summary: Net cash flow

Features:
□ Auto-calculate invoice status after payment
□ Receipt number auto-generated
□ Cash book combines payments (thu) + expenses (chi)
```

### Files Changed
```
src/
├── pages/payments/
│   └── PaymentsPage.tsx
├── pages/cash-book/
│   └── CashBookPage.tsx
├── pages/cash-flow/
│   └── CashFlowPage.tsx
├── components/payments/
│   ├── CollectPaymentDialog.tsx
│   └── PaymentReceiptDialog.tsx
└── hooks/
    ├── usePayments.ts
    └── useCashBook.ts
```

### Testing Checklist
```
Collect Payment:
□ Full payment → invoice.status = PAID
□ Partial payment → invoice.status = PARTIAL_PAID
□ Overpayment → show warning

Receipt:
□ Print receipt → PDF generated
□ Receipt number unique

Cash Book:
□ Shows all transactions (payments + expenses)
□ Balances calculated correctly
□ Filter by date works

Cash Flow:
□ Chart displays correctly
□ Net cash flow = Total income - Total expense
```

### Success Criteria
- Payment collection seamless
- Cash book accurate
- Cash flow report insightful

---

## PHASE 16: ASSET & VEHICLE MANAGEMENT (3 ngày)
**Mục tiêu**: Tài sản nội thất + Phương tiện

### Deliverables
- ✅ Assets management (inventory)
- ✅ Asset handover documents
- ✅ Vehicles management

### Tasks Checklist
```
Hooks:
□ src/hooks/useAssets.ts
  □ useAssets()
  □ useCreateAsset()
  □ useUpdateAsset()
  □ useAssetHandovers()
  □ useCreateHandover()
□ src/hooks/useVehicles.ts
  □ useVehicles()
  □ useCreateVehicle()
  □ useUpdateVehicle()

Components - Assets:
□ src/pages/assets/AssetsPage.tsx
  □ Table: Mã TS, Tên, Loại, Số lượng, Tình trạng, Vị trí (Building/Room), Actions
  □ Filter by category, location, condition
  □ "Tạo tài sản" button
□ src/components/assets/CreateAssetDialog.tsx
  □ Code, Name, Category, Supplier
  □ Quantity, Condition
  □ Purchase date, Purchase price
  □ Location (building, room)
□ src/components/assets/AssetHandoverDialog.tsx
  □ Contract selector
  □ Type: CHECK_IN / CHECK_OUT
  □ Items list (select from assets, input quantity, condition)
  □ Signatures (landlord + tenant)
  □ Generate PDF document

Components - Vehicles:
□ src/pages/vehicles/VehiclesPage.tsx
  □ Table: Loại xe, Biển số, Chủ xe, Hợp đồng, Phí gửi xe, Actions
  □ Filter by type, building
  □ "Thêm phương tiện" button
□ src/components/vehicles/CreateVehicleDialog.tsx
  □ Tenant selector
  □ Contract selector
  □ Vehicle type, Brand, Model
  □ License plate, Color
  □ Parking fee

Features:
□ Asset movements tracking (room → room)
□ Asset maintenance records
□ Handover PDF with signatures
□ Vehicle parking fee → added to invoice
```

### Files Changed
```
src/
├── pages/assets/
│   └── AssetsPage.tsx
├── pages/vehicles/
│   └── VehiclesPage.tsx
├── components/assets/
│   ├── CreateAssetDialog.tsx
│   └── AssetHandoverDialog.tsx
├── components/vehicles/
│   └── CreateVehicleDialog.tsx
└── hooks/
    ├── useAssets.ts
    └── useVehicles.ts
```

### Testing Checklist
```
Assets:
□ CRUD assets
□ Handover on check-in → PDF generated
□ Handover on check-out → compare conditions

Vehicles:
□ CRUD vehicles
□ Link to contract
□ Parking fee added to invoice
```

### Success Criteria
- Assets tracked comprehensively
- Handover documents professional
- Vehicles linked to contracts

---

## PHASE 17: ISSUES & TASKS (3 ngày)
**Mục tiêu**: Quản lý sự cố + Phân công công việc

### Deliverables
- ✅ Issues list page
- ✅ Create issue (from tenant or landlord)
- ✅ Assign issue to staff
- ✅ Track issue progress
- ✅ Issue comments/updates

### Tasks Checklist
```
Hooks:
□ src/hooks/useIssues.ts
  □ useIssues()
  □ useIssue(id)
  □ useCreateIssue()
  □ useUpdateIssue()
  □ useAssignIssue()
  □ useIssueComments(issue_id)
  □ useCreateComment()

Components:
□ src/pages/issues/IssuesPage.tsx
  □ Kanban board: NEW | ASSIGNED | IN_PROGRESS | RESOLVED | CLOSED
  □ Filter by priority, category, building
  □ "Tạo sự cố" button
□ src/pages/issues/IssueDetailPage.tsx
  □ Issue info: Title, Description, Category, Priority
  □ Location: Building, Room, Contract
  □ Reporter, Assigned to
  □ Timeline, Status
  □ Cost: Estimated, Actual
  □ Comments list
  □ Actions: Assign, Update status, Add comment, Rate (tenant)
□ src/components/issues/CreateIssueDialog.tsx
  □ Title, Description, Category
  □ Priority (LOW, MEDIUM, HIGH, URGENT)
  □ Building, Room, Contract
  □ Upload images
□ src/components/issues/AssignIssueDialog.tsx
  □ Select staff
  □ Due date
  □ Estimated cost
□ src/components/issues/IssueCommentForm.tsx
  □ Comment text
  □ Upload images
  □ Status change (if staff)

Features:
□ Tenant app (future) → report issue
□ Real-time updates for staff
□ Rating & feedback from tenant
□ Issue resolution time tracking
```

### Files Changed
```
src/
├── pages/issues/
│   ├── IssuesPage.tsx
│   └── IssueDetailPage.tsx
├── components/issues/
│   ├── CreateIssueDialog.tsx
│   ├── AssignIssueDialog.tsx
│   ├── IssueCard.tsx (for Kanban)
│   └── IssueCommentForm.tsx
└── hooks/
    └── useIssues.ts
```

### Testing Checklist
```
Create:
□ Create issue → status = NEW
□ Upload images → stored

Assign:
□ Assign to staff → status = ASSIGNED
□ Staff sees in their list

Progress:
□ Update status → IN_PROGRESS
□ Add comment → appears in timeline
□ Mark resolved → status = RESOLVED

Close:
□ Tenant confirms → status = CLOSED
□ Rating recorded
```

### Success Criteria
- Issues Kanban works smoothly
- Assignment & tracking clear
- Comments provide context

---

## PHASE 18: DASHBOARD & BUILDING MAP (3 ngày)
**Mục tiêu**: Bảng tin tổng quan + Sơ đồ tòa nhà

### Deliverables
- ✅ Dashboard with stats & charts
- ✅ Building map (grid view)
- ✅ Alerts & notifications

### Tasks Checklist
```
Hooks:
□ src/hooks/useDashboard.ts
  □ useDashboardStats()
  □ useRevenueChart(months)
  □ useOccupancyChart()
  □ useAlerts()

Components - Dashboard:
□ src/pages/dashboard/DashboardPage.tsx
  □ Overview cards:
    - Total rooms
    - Occupied rooms
    - Revenue this month
    - Total debt
  □ Charts:
    - Revenue line chart (last 12 months)
    - Occupancy pie chart
    - Debt bar chart
  □ Alerts:
    - Overdue invoices
    - Contracts expiring soon (30, 15, 7 days)
    - Unresolved issues > 24h
  □ Recent activities:
    - New contracts
    - Payments received
    - Issues reported

Components - Building Map:
□ src/pages/building-map/BuildingMapPage.tsx
  □ Building selector (dropdown)
  □ Floor selector (tabs)
  □ Grid layout:
    - 5 rooms per row (configurable)
    - Color coding:
      🟢 OCCUPIED (green)
      🔴 AVAILABLE (red)
      🟠 RESERVED (orange)
      🟣 EXPIRING_SOON (purple)
      ⚫ MAINTENANCE (gray)
  □ Room card: Tên phòng, Giá, Trạng thái
  □ Click room → Detail dialog
□ src/components/building-map/RoomDetailDialog.tsx
  □ Room info
  □ Current contract (if any)
  □ Tenant info
  □ Recent invoice
  □ Actions: Create contract, Report issue

Features:
□ Real-time stats (Supabase Realtime)
□ Interactive charts (Recharts)
□ Responsive grid (mobile friendly)
```

### Files Changed
```
src/
├── pages/dashboard/
│   └── DashboardPage.tsx
├── pages/building-map/
│   └── BuildingMapPage.tsx
├── components/dashboard/
│   ├── StatsCard.tsx
│   ├── RevenueChart.tsx
│   ├── OccupancyChart.tsx
│   └── AlertsList.tsx
├── components/building-map/
│   ├── RoomCard.tsx
│   └── RoomDetailDialog.tsx
└── hooks/
    └── useDashboard.ts
```

### Testing Checklist
```
Dashboard:
□ Stats display correctly
□ Charts render without errors
□ Alerts show relevant issues
□ Recent activities update

Building Map:
□ Grid displays rooms correctly
□ Color coding accurate
□ Click room → detail dialog opens
□ Filter by building works
```

### Success Criteria
- Dashboard informative & real-time
- Building map intuitive & visual

---

## PHASE 19: REPORTS SYSTEM (4 ngày)
**Mục tiêu**: 19 loại báo cáo + Export Excel/PDF

### Deliverables
- ✅ 8 báo cáo BĐS
- ✅ 8 báo cáo Tài chính
- ✅ 3 báo cáo Công việc
- ✅ Export Excel, PDF, CSV

### Tasks Checklist
```
Hooks:
□ src/hooks/useReports.ts
  □ useVacantRoomsReport()
  □ useExpiringContractsReport()
  □ useOccupancyReport()
  □ useRevenueReport(start, end)
  □ useDebtReport()
  □ useCashBookReport(start, end)
  □ useProfitReport(month)
  □ useTasksReport()
  □ useExportReport(type, format)

Components - Real Estate Reports:
□ src/pages/reports/VacantRoomsReport.tsx
  □ Table: Building, Room, Days vacant, Last rent price
  □ Filter by building
□ src/pages/reports/ExpiringContractsReport.tsx
  □ Table: Contract, Tenant, Room, End date, Days left
  □ Filter by days left (7, 15, 30)
□ src/pages/reports/OccupancyReport.tsx
  □ Chart: Tỷ lệ lấp đầy theo tháng
  □ Table: By building
□ ... (5 more reports)

Components - Finance Reports:
□ src/pages/reports/RevenueReport.tsx
  □ Date range picker
  □ Table: Month, Revenue, Growth %
  □ Chart: Revenue trend
□ src/pages/reports/DebtReport.tsx
  □ Table: Contract, Tenant, Total debt, Days overdue
  □ Aging analysis (0-30, 31-60, 61-90, >90 days)
□ src/pages/reports/CashBookReport.tsx
  □ Date range
  □ Table: Date, Type, Description, Amount, Balance
  □ Summary: Opening, Income, Expense, Closing
□ ... (5 more reports)

Components - Tasks Reports:
□ src/pages/reports/TasksOverviewReport.tsx
  □ Total, Completed, In progress, Overdue
  □ Chart: By category
□ ... (2 more reports)

Features:
□ Export to Excel (XLSX)
□ Export to PDF
□ Export to CSV
□ Print report
□ Schedule report (future)
```

### Files Changed
```
src/
├── pages/reports/
│   ├── real-estate/
│   │   ├── VacantRoomsReport.tsx
│   │   ├── ExpiringContractsReport.tsx
│   │   ├── OccupancyReport.tsx
│   │   ├── PromotionsReport.tsx
│   │   ├── NewLeasesReport.tsx
│   │   ├── TerminationsReport.tsx
│   │   └── PriceHistoryReport.tsx
│   ├── finance/
│   │   ├── RevenueReport.tsx
│   │   ├── DebtReport.tsx
│   │   ├── CashBookReport.tsx
│   │   ├── CashFlowReport.tsx
│   │   ├── ProfitReport.tsx
│   │   ├── PaymentScheduleReport.tsx
│   │   ├── OverpaymentReport.tsx
│   │   └── DepositsReport.tsx
│   └── tasks/
│       ├── TasksOverviewReport.tsx
│       ├── TasksByStaffReport.tsx
│       └── TasksByRoomReport.tsx
├── components/reports/
│   ├── ReportLayout.tsx
│   ├── ExportButtons.tsx
│   └── DateRangePicker.tsx
└── hooks/
    ├── useReports.ts
    └── useExport.ts
```

### Testing Checklist
```
Reports:
□ All 19 reports display correctly
□ Filters work
□ Charts render

Export:
□ Excel export works
□ PDF export works
□ CSV export works
□ Data accurate in exports
```

### Success Criteria
- All 19 reports functional
- Export formats work well
- Reports insightful

---

## PHASE 20: NOTIFICATIONS & SETTINGS (4 ngày)
**Mục tiêu**: Thông báo + Cài đặt + Polish

### Deliverables
- ✅ Notification system (in-app)
- ✅ Settings pages (General, Templates, Signatures, Staff)
- ✅ Code generation system
- ✅ Testing & Bug fixes
- ✅ Performance optimization
- ✅ Documentation

### Tasks Checklist
```
Notifications:
□ src/hooks/useNotifications.ts
  □ useNotifications()
  □ useMarkAsRead()
□ src/components/layout/NotificationBell.tsx
  □ Bell icon with badge (unread count)
  □ Dropdown with notification list
  □ Mark all as read

Settings - General:
□ src/pages/settings/GeneralSettingsPage.tsx
  □ Company info
  □ Contract configuration (11 options)
  □ Invoice configuration (9 options)
  □ Payment & Notification settings

Settings - Templates:
□ src/pages/settings/TemplatesPage.tsx
  □ Contract templates (upload DOCX)
  □ Invoice templates (A4, Thermal)
  □ Receipt templates
  □ Template variables preview

Settings - Signatures:
□ src/pages/settings/SignaturesPage.tsx
  □ CRUD signature templates
  □ Upload, Draw (Canvas), Text methods
  □ Preview

Settings - Staff:
□ src/pages/settings/StaffPage.tsx
  □ Add staff (future - requires multi-user support)
  □ RBAC setup (future)

Code Generation:
□ src/hooks/useCodeGeneration.ts
  □ Configure formats per object type
  □ Reset periods
□ Integrate into create forms (building, room, contract, invoice)

Testing & Polish:
□ Run full E2E test suite
□ Fix all bugs
□ Optimize slow queries
□ Add loading states
□ Error boundaries
□ Toast notifications consistent
□ Accessibility audit

Documentation:
□ Update README.md
□ API documentation
□ User guide (basic)
□ Developer guide
```

### Files Changed
```
src/
├── pages/settings/
│   ├── GeneralSettingsPage.tsx
│   ├── TemplatesPage.tsx
│   ├── SignaturesPage.tsx
│   └── StaffPage.tsx
├── components/
│   ├── layout/NotificationBell.tsx
│   └── settings/ (various)
├── hooks/
│   ├── useNotifications.ts
│   └── useCodeGeneration.ts
└── lib/
    └── codeGenerator.ts
```

### Testing Checklist
```
Notifications:
□ Real-time notifications work
□ Mark as read works
□ Badge count accurate

Settings:
□ All settings save correctly
□ Templates upload & preview
□ Signatures CRUD works

Code Generation:
□ Auto-codes generated correctly
□ Formats customizable
□ Reset periods work

Polish:
□ No console errors
□ Loading states smooth
□ Error messages clear
□ Mobile responsive
□ Performance good (< 2s page load)
```

### Success Criteria
- Notification system functional
- Settings comprehensive
- System polished & production-ready

---

## 🎯 CÁCH SỬ DỤNG PLAN NÀY

### Cho Developer
1. **Đọc toàn bộ plan** để hiểu big picture
2. **Bắt đầu từ Phase 1** - không skip
3. **Hoàn thành checklist** trong mỗi phase
4. **Test kỹ** trước khi sang phase tiếp theo
5. **Commit thường xuyên** - mỗi task nhỏ nên có 1 commit
6. **Update plan** nếu có thay đổi

### Theo dõi tiến độ
```
Tạo file: PROGRESS.md

# Progress Tracking

## Phase 1: Database Foundation
- [x] Setup Supabase project
- [x] Migration 1 - Extensions & Enums
- [x] Migration 2 - Core Tables (Part 1)
- [x] Migration 3 - Core Tables (Part 2)
- [ ] Migration 4 - Contract Tables
- [ ] Migration 5 - Billing Tables
... (và tiếp tục)
```

### Ước lượng thời gian thực tế
- **Junior Dev**: Mỗi phase × 1.5 (tổng ~15-21 tuần)
- **Mid-level Dev**: Theo plan (10-14 tuần)
- **Senior Dev**: Mỗi phase × 0.7 (tổng ~7-10 tuần)

---

## 📊 DEPENDENCIES GIỮA CÁC PHASE

```
P1 (Database) ──┬──> P2 (Auth) ──> P3 (Layout)
                │
                ├──> P4 (Areas) ──> P5 (Buildings) ──> P6 (Rooms) ──> P7 (Beds)
                │                                         │
                ├──> P8 (Services) ───────────────────────┤
                │                                         │
                └──> P9 (Tenants) ──> P10 (Lead/Deposit)─┴──> P11 (Contracts Create)
                                                                      │
                                                                      ├──> P12 (Contracts Lifecycle)
                                                                      │
                                                                      ├──> P13 (Meter Readings) ──> P14 (Invoices)
                                                                      │                                  │
                                                                      │                                  └──> P15 (Payments)
                                                                      │
                                                                      ├──> P16 (Assets/Vehicles)
                                                                      │
                                                                      └──> P17 (Issues)

P18 (Dashboard) ─────────────────────────> (depends on all above)

P19 (Reports) ───────────────────────────> (depends on all above)

P20 (Notifications/Settings) ───────────> (depends on all above)
```

**Quy tắc**: Không được làm phase nào đó trước khi hoàn thành tất cả dependencies của nó.

---

## 🚀 READY TO START!

**Next action**: Bắt đầu Phase 1 - Database Foundation

**Command**:
```bash
# Create new branch for Phase 1
git checkout -b phase-1-database-foundation

# Start working...
```

---

**Tác giả**: AI Agent (Claude)
**Ngày tạo**: 2025-11-18
**Phiên bản**: 1.0.0
**Tham khảo**:
- docs/README.md
- docs/00-OVERVIEW.md
- docs/01-DATABASE-SCHEMA.md
- docs/ANALYSIS-MISSING-FEATURES.md
