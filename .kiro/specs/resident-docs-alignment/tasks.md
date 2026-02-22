# Kế hoạch Triển khai: Đồng bộ Ứng dụng Web với Tài liệu Hướng dẫn Resident

## Tổng quan

Kế hoạch triển khai chia thành các giai đoạn tuần tự: Database trước, sau đó xóa module không cần, tái cấu trúc routing/sidebar, đổi thuật ngữ, bổ sung module mới, báo cáo, cài đặt, UX enhancements. Mỗi task xây dựng trên kết quả của task trước, đảm bảo không có code orphan.

## Tasks

- [x] 1. Tạo bảng database mới và migration
  - [x] 1.1 Tạo Supabase migration cho bảng `floors`
    - Tạo file migration SQL trong `supabase/migrations/`
    - Bảng `floors`: id, building_id (FK → buildings), floor_number, name, description, status, user_id, created_at, updated_at
    - Thêm UNIQUE constraint (building_id, floor_number)
    - Thêm RLS policies cho bảng
    - _Yêu cầu: 38.1, 31.7_

  - [x] 1.2 Tạo Supabase migration cho bảng `hotlines`
    - Bảng `hotlines`: id, name, phone_number, description, is_active, user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.2, 31.4_

  - [x] 1.3 Tạo Supabase migration cho bảng `income_expense_types`
    - Bảng `income_expense_types`: id, name, type (CHECK 'income'/'expense'), description, is_default, user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.3, 31.2_

  - [x] 1.4 Tạo Supabase migration cho bảng `service_quotas`
    - Bảng `service_quotas`: id, service_id (FK → services), building_id (FK → buildings), quota_value, unit, description, user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.4, 31.2_

  - [x] 1.5 Tạo Supabase migration cho bảng `meters`
    - Bảng `meters`: id, room_id (FK → rooms), meter_type (CHECK 'electricity'/'water'), meter_code, initial_reading, current_reading, status, user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.5, 31.2_

  - [x] 1.6 Tạo Supabase migration cho bảng `auto_debt_config`
    - Bảng `auto_debt_config`: id, building_id (FK → buildings), is_enabled, bank_account, matching_rules (JSONB), user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.6, 31.2_

  - [x] 1.7 Tạo Supabase migration cho bảng `document_templates`
    - Bảng `document_templates`: id, type (CHECK 6 loại), name, content, is_default, variables (JSONB), user_id, created_at, updated_at
    - Thêm RLS policies
    - _Yêu cầu: 38.7, 32.1-32.6_

  - [x] 1.8 Tạo Supabase migration cho bảng `roles` và `staff_assignments`
    - Bảng `roles`: id, name, description, permissions (JSONB), user_id, created_at, updated_at
    - Bảng `staff_assignments`: id, staff_id (FK → auth.users), role_id (FK → roles), building_id (FK → buildings), user_id, created_at, updated_at, UNIQUE(staff_id, building_id)
    - Thêm RLS policies cho cả 2 bảng
    - _Yêu cầu: 38.8, 33.1-33.4_

  - [x] 1.9 Tạo Supabase migration cho bảng `subscription_plans` và `user_subscriptions`
    - Bảng `subscription_plans`: id, name, description, price, duration_months, max_rooms, max_buildings, features (JSONB), is_active, created_at, updated_at
    - Bảng `user_subscriptions`: id, user_id (FK → auth.users), plan_id (FK → subscription_plans), start_date, end_date, status, created_at, updated_at
    - Thêm RLS policies cho cả 2 bảng
    - _Yêu cầu: 38.9, 34.2_

  - [x] 1.10 Tạo Supabase migration cho bảng `task_types` và `asset_warehouses`
    - Bảng `task_types`: id, name, description, color, user_id, created_at, updated_at
    - Bảng `asset_warehouses`: id, name, location, building_id (FK → buildings), user_id, created_at, updated_at
    - Thêm RLS policies cho cả 2 bảng
    - _Yêu cầu: 31.5, 31.3_

  - [x] 1.11 Tạo migration xóa bảng `areas` và cập nhật bảng `buildings`
    - Xóa cột `area_id` khỏi bảng `buildings` (DROP CONSTRAINT + DROP COLUMN)
    - Xóa bảng `areas` (DROP TABLE CASCADE)
    - _Yêu cầu: 1.10, 36.6_

  - [x] 1.12 Tạo migration bổ sung settings keys mới vào bảng `settings`
    - Thêm 20+ settings keys cho 4 tabs: Hợp đồng (7 keys), Hóa đơn (10 keys), Thu chi (1 key), Thông báo (2 keys)
    - Insert default values cho mỗi key
    - _Yêu cầu: 30.1-30.5_

  - [ ]* 1.13 Viết unit tests cho migrations
    - Test tạo bảng thành công
    - Test foreign key constraints
    - Test RLS policies
    - _Yêu cầu: 38.1-38.9_

- [x] 2. Tạo TypeScript types và Supabase hooks cho bảng mới
  - [x] 2.1 Cập nhật Supabase types trong `src/integrations/supabase/`
    - Chạy `supabase gen types typescript` hoặc cập nhật thủ công file types
    - Thêm types cho tất cả 13 bảng mới: floors, hotlines, income_expense_types, service_quotas, meters, auto_debt_config, document_templates, roles, staff_assignments, subscription_plans, user_subscriptions, task_types, asset_warehouses
    - Xóa type `areas` khỏi types
    - _Yêu cầu: 38.1-38.9_

  - [x] 2.2 Tạo hook `src/hooks/useFloors.ts`
    - CRUD operations cho bảng floors
    - Lọc theo building_id
    - _Yêu cầu: 31.7, 38.1_

  - [x] 2.3 Tạo hook `src/hooks/useHotlines.ts`
    - CRUD operations cho bảng hotlines
    - _Yêu cầu: 31.4, 38.2_

  - [x] 2.4 Tạo hook `src/hooks/useIncomeExpenseTypes.ts`
    - CRUD operations cho bảng income_expense_types
    - Lọc theo type (income/expense)
    - _Yêu cầu: 31.2, 38.3_

  - [x] 2.5 Tạo hook `src/hooks/useServiceQuotas.ts`
    - CRUD operations cho bảng service_quotas
    - Lọc theo service_id, building_id
    - _Yêu cầu: 31.2, 38.4_

  - [x] 2.6 Tạo hook `src/hooks/useMeters.ts`
    - CRUD operations cho bảng meters
    - Lọc theo room_id, meter_type
    - _Yêu cầu: 31.2, 38.5_

  - [x] 2.7 Tạo hook `src/hooks/useAutoDebtConfig.ts`
    - CRUD operations cho bảng auto_debt_config
    - _Yêu cầu: 31.2, 38.6_

  - [x] 2.8 Tạo hook `src/hooks/useRoles.ts`
    - CRUD operations cho bảng roles
    - Quản lý permissions JSONB
    - _Yêu cầu: 33.1, 38.8_

  - [x] 2.9 Tạo hook `src/hooks/useStaffAssignments.ts`
    - CRUD operations cho bảng staff_assignments
    - Join với roles và buildings
    - _Yêu cầu: 33.2-33.4, 38.8_

  - [x] 2.10 Tạo hook `src/hooks/useSubscription.ts`
    - Đọc subscription_plans
    - CRUD cho user_subscriptions
    - _Yêu cầu: 34.2, 38.9_

  - [x] 2.11 Tạo hook `src/hooks/useTaskTypes.ts`
    - CRUD operations cho bảng task_types
    - _Yêu cầu: 31.5_

  - [x] 2.12 Tạo hook `src/hooks/useAssetWarehouses.ts`
    - CRUD operations cho bảng asset_warehouses
    - _Yêu cầu: 31.3_

- [x] 3. Checkpoint - Kiểm tra database và hooks
  - Đảm bảo tất cả migrations chạy thành công, hooks compile không lỗi. Hỏi user nếu có thắc mắc.

- [x] 4. Xóa module không cần thiết
  - [x] 4.1 Xóa module Khu vực (Areas)
    - Xóa thư mục `src/pages/areas/`
    - Xóa thư mục `src/components/areas/`
    - Xóa file `src/hooks/useAreas.ts`
    - Xóa tất cả import/reference đến Areas trong codebase
    - _Yêu cầu: 1.10, 36.6_

  - [x] 4.2 Xóa module Trợ lý AI (AI Assistant)
    - Xóa thư mục `src/components/ai/`
    - Xóa file `src/hooks/useAIAssistant.ts`
    - Xóa file `src/types/ai.ts`
    - Xóa tất cả import/reference đến AI trong codebase
    - _Yêu cầu: 1.11_

  - [x] 4.3 Xóa/di chuyển các báo cáo không có trong SUMMARY.md
    - Xóa `src/pages/reports/real-estate/PriceHistoryReport.tsx` (nếu tồn tại)
    - Xóa `src/pages/reports/real-estate/ContractChangesReport.tsx` (nếu tồn tại)
    - Xóa route references tương ứng
    - _Yêu cầu: 39.2_

  - [x] 4.4 Tách Duyệt thanh lý khỏi menu riêng
    - Xóa `src/pages/contracts/TerminationApprovalsPage.tsx` nếu là trang riêng
    - Tích hợp logic duyệt thanh lý vào `src/pages/contracts/` (tab hoặc section trong trang Hợp đồng)
    - Xóa route `/termination-approvals` hoặc tương tự
    - _Yêu cầu: 36.7, 12.5_

  - [ ]* 4.5 Viết tests kiểm tra các module đã xóa không còn reference
    - Grep codebase đảm bảo không còn import areas, ai, price-history, contract-changes
    - _Yêu cầu: 1.10, 1.11, 39.2_

- [x] 5. Tái cấu trúc Routing và đổi tên Route
  - [x] 5.1 Cập nhật route definitions trong `src/App.tsx`
    - Đổi `/rooms` → `/apartments` (redirect cũ → mới)
    - Đổi `/tenants` → `/customers` (redirect cũ → mới)
    - Đổi `/issues` → `/tasks` (redirect cũ → mới)
    - Đổi `/payments` → `/income-expense` (redirect cũ → mới)
    - Thêm redirect routes từ URL cũ sang URL mới để không break bookmarks
    - _Yêu cầu: 6.1, 13.3, 19.5, 36.1-36.4_

  - [x] 5.2 Thêm route mới cho các trang chưa có
    - `/building-map` → BuildingMapPage (có thể đã tồn tại, kiểm tra)
    - `/settings/categories` → CategoriesPage (NEW)
    - `/settings/categories/:section` → Category sub-pages (NEW)
    - `/account/profile` → ProfilePage (NEW)
    - `/account/subscription` → SubscriptionPage (NEW)
    - _Yêu cầu: 4.1, 31.1, 34.1-34.3_

  - [x] 5.3 Thêm routes cho Báo cáo BĐS
    - `/reports/real-estate` → RealEstateReportsPage (index)
    - `/reports/real-estate/vacant` → Căn hộ trống
    - `/reports/real-estate/expiring` → Căn hộ sắp trống
    - `/reports/real-estate/renewals-transfers` → Phòng gia hạn, chuyển nhượng (NEW)
    - `/reports/real-estate/occupancy-old` → Tỉ lệ lấp đầy (cũ) (NEW/SPLIT)
    - `/reports/real-estate/occupancy-new` → Tỉ lệ lấp đầy (mới) (NEW/SPLIT)
    - `/reports/real-estate/promotions` → Báo cáo khuyến mại
    - `/reports/real-estate/new-leases` → Báo cáo cho thuê
    - `/reports/real-estate/terminations` → Báo cáo bỏ trả
    - _Yêu cầu: 39.1, 39.3_

  - [x] 5.4 Thêm routes cho Báo cáo Tài chính
    - `/reports/finance` → FinanceReportsPage (index)
    - `/reports/finance/daily-cashbook` → Sổ quỹ theo ngày (moved from /cash-book)
    - `/reports/finance/cash-flow` → Dòng tiền
    - `/reports/finance/profit-distribution` → Phân bổ lợi nhuận
    - `/reports/finance/new-contract-debt` → Công nợ hợp đồng mới
    - `/reports/finance/customer-debt` → Khách nợ tiền
    - `/reports/finance/payment-schedule` → Lịch thanh toán
    - `/reports/finance/overpayment` → Tiền thừa
    - `/reports/finance/deposits` → Danh sách tiền cọc
    - _Yêu cầu: 40.1, 40.2_

  - [x] 5.5 Thêm routes cho Báo cáo Công việc
    - `/reports/tasks` → TaskReportsPage (index)
    - `/reports/tasks/overview` → Tổng quan công việc
    - `/reports/tasks/by-staff` → CV theo nhân viên
    - `/reports/tasks/by-apartment` → CV theo căn hộ
    - _Yêu cầu: 29.1-29.4_

  - [x] 5.6 Xóa route `/cash-book` cũ, thêm redirect sang `/reports/finance/daily-cashbook`
    - Xóa hoặc redirect route `/cash-book`
    - Xóa trang `src/pages/cash-book/` nếu logic đã di chuyển
    - _Yêu cầu: 1.9_

- [x] 6. Tái cấu trúc Sidebar Navigation
  - [x] 6.1 Cập nhật navigation config trong Sidebar component
    - Mở `src/components/layout/Sidebar.tsx` (hoặc file navigation config tương ứng)
    - Thay thế toàn bộ navigation structure theo design document
    - Nhóm: Theo dõi nhanh (Bảng tin, Sơ đồ toà nhà)
    - Nhóm: Quản lý & Vận hành (Danh mục dữ liệu, Khách hàng, Tài chính, Thông báo, Công việc)
    - Nhóm: Báo cáo (Báo cáo BĐS, Báo cáo Tài chính, Báo cáo Công việc)
    - Nhóm: Cài đặt hệ thống (Cài đặt chung, Danh mục khác, Mẫu biểu, Nhân viên)
    - Nhóm: Tài khoản (Thông tin cá nhân, Gói cước)
    - _Yêu cầu: 1.1-1.11_

  - [x] 6.2 Đổi tên labels trong Sidebar
    - "Tổng quan" → "Bảng tin"
    - "Phòng" → "Căn hộ"
    - "Khách thuê" → "Khách hàng"
    - "Sự cố" → "Công việc"
    - "Leads" → "Khách hẹn"
    - Xóa "Khu vực", "Trợ lý AI", "Duyệt thanh lý" khỏi sidebar
    - Di chuyển "Sổ quỹ" khỏi nhóm Tài chính
    - _Yêu cầu: 36.1-36.7_

  - [x] 6.3 Cập nhật Sidebar icons cho các mục mới
    - Import icons phù hợp cho: Sơ đồ toà nhà (Map), Danh mục khác (List), Tài khoản (UserCircle)
    - Đảm bảo mỗi mục menu có icon tương ứng
    - _Yêu cầu: 1.1_

  - [ ]* 6.4 Viết tests cho Sidebar navigation
    - Test render đúng số lượng menu items
    - Test thứ tự menu items khớp SUMMARY.md
    - Test không còn mục Areas, AI Assistant, Duyệt thanh lý
    - _Yêu cầu: 1.1-1.11_

- [x] 7. Checkpoint - Kiểm tra routing và sidebar
  - Đảm bảo tất cả routes hoạt động, sidebar hiển thị đúng cấu trúc, redirects từ URL cũ hoạt động. Hỏi user nếu có thắc mắc.

- [x] 8. Đổi thuật ngữ toàn bộ codebase
  - [x] 8.1 Đổi "Phòng" → "Căn hộ" trong UI labels
    - Tìm và thay thế tất cả UI strings "Phòng" → "Căn hộ" trong components: rooms, building-map, contracts, invoices, reports, dashboard
    - Cập nhật page titles, table headers, form labels, button texts, toast messages
    - Giữ nguyên tên bảng DB `rooms` - chỉ đổi UI label
    - _Yêu cầu: 36.1, 6.1_

  - [x] 8.2 Đổi "Sự cố" → "Công việc" trong UI labels
    - Tìm và thay thế tất cả UI strings "Sự cố"/"Issues" → "Công việc" trong components: issues, dashboard, reports
    - Cập nhật `src/components/issues/` - đổi labels bên trong (giữ nguyên tên folder/file)
    - Cập nhật `src/lib/issueHelpers.ts` - đổi labels bên trong
    - _Yêu cầu: 36.2, 19.5_

  - [x] 8.3 Đổi "Leads" → "Khách hẹn" trong UI labels
    - Tìm và thay thế tất cả UI strings "Leads" → "Khách hẹn" trong components: leads
    - Cập nhật `src/lib/leadHelpers.ts` - đổi labels bên trong
    - _Yêu cầu: 36.3_

  - [x] 8.4 Đổi "Tổng quan" → "Bảng tin" cho Dashboard
    - Cập nhật page title trong `src/pages/Dashboard.tsx`
    - Cập nhật breadcrumb label
    - _Yêu cầu: 36.4_

  - [x] 8.5 Đổi "Master Data" → "Danh mục dữ liệu" nếu có
    - Tìm và thay thế tất cả references "Master Data" → "Danh mục dữ liệu"
    - _Yêu cầu: 36.5_

  - [x] 8.6 Cập nhật thông báo hệ thống sang tiếng Việt chuẩn
    - Đảm bảo tất cả toast messages, confirm dialogs, error messages dùng tiếng Việt
    - Format: "Dữ liệu đã được TẠO thành công", "Dữ liệu đã được CẬP NHẬT thành công", v.v.
    - _Yêu cầu: 36.8_

- [x] 9. Nâng cấp Dashboard (Bảng tin)
  - [x] 9.1 Cập nhật `src/pages/Dashboard.tsx` với đầy đủ thành phần
    - Stats cards: Tổng số phòng, Đang thuê, Trống, Doanh thu tháng, Công nợ tổng
    - Line chart: Doanh thu theo tháng (sử dụng Recharts)
    - Pie chart: Tỷ lệ lấp đầy (sử dụng Recharts)
    - Alert list: Hóa đơn quá hạn, HĐ sắp hết hạn, Sự cố chưa xử lý
    - Recent activities feed
    - Building filter dropdown
    - Cập nhật `src/hooks/useDashboard.ts` nếu cần thêm queries
    - _Yêu cầu: 3.1-3.6_

  - [ ]* 9.2 Viết unit tests cho Dashboard components
    - Test render stats cards với mock data
    - Test building filter hoạt động
    - _Yêu cầu: 3.1-3.6_

- [x] 10. Nâng cấp Sơ đồ Toà nhà
  - [x] 10.1 Cập nhật `src/pages/building-map/BuildingMapPage.tsx`
    - Hiển thị sơ đồ phòng theo tầng dạng Grid view
    - Mã màu trạng thái: Xanh (Đang thuê), Cam (Đã đặt cọc), Đỏ (Trống), Tím (Sắp trống), Xám (Ngừng hoạt động)
    - Popup khi click phòng: Tên phòng, diện tích, giá, HĐ hiện tại, khách thuê, hóa đơn gần nhất
    - Bộ lọc: Toà nhà, Tầng, Trạng thái
    - Tìm kiếm phòng trên sơ đồ
    - Tích hợp với hook `useFloors` để lấy danh sách tầng
    - _Yêu cầu: 4.1-4.5_

  - [ ]* 10.2 Viết unit tests cho BuildingMap components
    - Test render grid với mock rooms data
    - Test color coding theo status
    - Test popup hiển thị đúng thông tin
    - _Yêu cầu: 4.1-4.3_

- [x] 11. Cập nhật các trang Danh mục dữ liệu hiện có
  - [x] 11.1 Cập nhật trang Căn hộ (Rooms → Apartments)
    - Cập nhật `src/pages/rooms/` - đổi tất cả labels "Phòng" → "Căn hộ"
    - Cập nhật `src/components/rooms/` - đổi labels trong form, table, filters
    - Thêm bộ lọc theo tầng (sử dụng hook useFloors)
    - Đảm bảo form có đầy đủ trường: Toà nhà, Tầng, Tên căn hộ, Diện tích, Giá thuê, Số người tối đa, Tiện ích, Ảnh
    - Thêm chi tiết căn hộ: Thông tin cơ bản, HĐ hiện tại, Tài sản trong phòng, Lịch sử hóa đơn
    - _Yêu cầu: 6.1-6.4_

  - [x] 11.2 Cập nhật trang Tài sản
    - Cập nhật `src/pages/assets/` và `src/components/assets/`
    - Đảm bảo form có đầy đủ trường: Mã tài sản, Tên, Loại tài sản, Số lượng, Giá trị, Tình trạng, Vị trí, Nhà cung cấp, Ngày mua
    - Thêm bộ lọc theo toà nhà, phòng, loại, tình trạng
    - Thêm tab/section lịch sử di chuyển tài sản
    - Thêm tab/section lịch sử sửa chữa tài sản
    - _Yêu cầu: 9.1-9.4_

  - [x] 11.3 Cập nhật trang Khách hẹn (Leads)
    - Cập nhật `src/pages/leads/` và `src/components/leads/` - đổi labels "Leads" → "Khách hẹn"
    - Đảm bảo form có đầy đủ trường: Tên, SĐT, Email, Nguồn, Toà nhà, Phòng quan tâm, Thời gian hẹn, NV phụ trách, Ghi chú
    - Đảm bảo có trạng thái: Mới, Đã hẹn, Đang tư vấn, Đã chuyển đổi, Thất bại
    - Đảm bảo có chức năng chuyển đổi khách hẹn → đặt cọc
    - Thêm lịch sử hoạt động cho từng khách hẹn
    - _Yêu cầu: 10.1-10.4_

  - [x] 11.4 Cập nhật trang Khách hàng (Tenants → Customers)
    - Cập nhật `src/pages/tenants/` hoặc `src/pages/customers/` - đổi labels
    - Cập nhật `src/components/tenants/` hoặc `src/components/customers/`
    - Đảm bảo hiển thị: Tên, SĐT, Email, CMND/CCCD, Phòng đang thuê, Trạng thái HĐ
    - Thêm chi tiết: Thông tin cá nhân, Lịch sử HĐ, Lịch sử thanh toán, Phương tiện
    - _Yêu cầu: 13.1-13.3_

  - [x] 11.5 Cập nhật trang Công việc (Issues → Tasks)
    - Cập nhật `src/pages/issues/` và `src/components/issues/` - đổi labels "Sự cố" → "Công việc"
    - Đảm bảo form có: Tiêu đề, Mô tả, Loại công việc (sử dụng task_types), Mức độ ưu tiên, Phòng/Toà nhà, Người phụ trách, Hạn hoàn thành, Ảnh
    - Trạng thái: Mới, Đã phân công, Đang xử lý, Hoàn thành, Đã đóng
    - Thêm cập nhật tiến độ với ghi chú và ảnh
    - Thêm ghi nhận chi phí phát sinh
    - Tích hợp với hook useTaskTypes
    - _Yêu cầu: 19.1-19.5_

  - [x] 11.6 Cập nhật trang Thu chi (Payments → Income-Expense)
    - Cập nhật `src/pages/payments/` và `src/components/payments/`
    - Đảm bảo form có: Loại (Thu/Chi), Số tiền, Phương thức thanh toán, Liên kết hóa đơn, Ghi chú
    - Tích hợp với income_expense_types từ Danh mục khác
    - Hỗ trợ tự động duyệt khi setting bật
    - Hỗ trợ in phiếu thu/chi theo mẫu biểu
    - _Yêu cầu: 17.1-17.4_

- [x] 12. Checkpoint - Kiểm tra thuật ngữ và trang cập nhật
  - Đảm bảo tất cả thuật ngữ đã đổi đúng, các trang hiện có hoạt động với route mới. Hỏi user nếu có thắc mắc.

- [x] 13. Tạo trang Cài đặt chung 5 tabs
  - [x] 13.1 Tạo/cập nhật `src/pages/settings/GeneralSettingsPage.tsx`
    - Tạo layout 5 tabs: Cài đặt cơ bản, Hợp đồng, Hóa đơn, Thu chi, Thông báo
    - Tab "Cài đặt cơ bản": Upload logo
    - Sử dụng hook `useSettings` để đọc/ghi settings
    - _Yêu cầu: 30.1_

  - [x] 13.2 Implement tab "Hợp đồng" với 7 toggles
    - Tự cài số người dùng DV (`contract_auto_set_service_users`)
    - Kiểm kê tài sản khi ký/thanh lý (`contract_asset_inspection`)
    - Tự động lập HĐ mới khi gia hạn (`contract_auto_create_on_renewal`)
    - Ký HĐ online (`contract_e_signing_enabled`)
    - Cài đặt ngày thanh toán (`contract_payment_date_setting`)
    - Hiển thị trạng thái sắp hết hạn (`contract_show_expiring_status`)
    - Nhận thông báo quá hạn HĐ (`contract_overdue_notification`)
    - Mỗi toggle có tooltip mô tả chức năng
    - _Yêu cầu: 30.2, 37.1_

  - [x] 13.3 Implement tab "Hóa đơn" với 10 toggles
    - Tự động duyệt chỉ số (`invoice_auto_approve_meter`)
    - Tự động duyệt hóa đơn (`invoice_auto_approve`)
    - Sử dụng hệ số (`invoice_use_coefficient`)
    - Tự động tính hệ số theo ngày (`invoice_auto_calc_coefficient`)
    - Chu kỳ tính dịch vụ (`invoice_service_cycle_type`) - dropdown 3 options
    - Chia tỷ lệ lẻ ngày (`invoice_prorate_method`) - dropdown 2 options
    - Hạn thanh toán (`invoice_payment_deadline_days`) - number input
    - Tự lập hóa đơn đặt cọc (`invoice_auto_create_deposit`)
    - Tự động sinh hóa đơn kỳ tiếp (`invoice_auto_generate_next`)
    - Cho phép cư dân chốt điện nước (`invoice_allow_tenant_meter`)
    - Mỗi toggle/dropdown có tooltip mô tả chức năng
    - _Yêu cầu: 30.3, 37.1_

  - [x] 13.4 Implement tab "Thu chi" và tab "Thông báo"
    - Tab Thu chi: Toggle tự động duyệt thu chi (`payment_auto_approve`)
    - Tab Thông báo: Toggle nhắc ngày lập hóa đơn (`notification_invoice_reminder`), Toggle nhắc hạn thanh toán (`notification_payment_reminder`)
    - Mỗi toggle có tooltip mô tả chức năng
    - _Yêu cầu: 30.4, 30.5, 37.1_

  - [ ]* 13.5 Viết unit tests cho GeneralSettingsPage
    - Test render 5 tabs
    - Test toggle state changes
    - Test save settings
    - _Yêu cầu: 30.1-30.5_

- [x] 14. Tạo trang Danh mục khác (NEW)
  - [x] 14.1 Tạo `src/pages/settings/CategoriesPage.tsx` - trang tổng hợp
    - Layout dạng grid/list hiển thị tất cả danh mục con
    - Nhóm Tài chính: Tài khoản ngân hàng, Gạch nợ tự động, Loại thu chi, Định mức dịch vụ, Đồng hồ công tơ
    - Nhóm Tài sản: Nhà cung cấp, Kho tài sản, Loại tài sản, Lịch sử di chuyển, Lịch sử sửa chữa
    - Mục riêng: Quản lý Hotline, Loại công việc, Danh mục chung, Danh sách tầng
    - Mỗi mục link đến sub-page tương ứng
    - _Yêu cầu: 31.1_

  - [x] 14.2 Tạo sub-pages Tài chính trong `src/pages/settings/categories/`
    - `BankAccountsPage.tsx` - CRUD tài khoản ngân hàng
    - `AutoDebtPage.tsx` - Cấu hình gạch nợ tự động (sử dụng useAutoDebtConfig)
    - `IncomeExpenseTypesPage.tsx` - CRUD loại thu chi (sử dụng useIncomeExpenseTypes)
    - `ServiceQuotasPage.tsx` - CRUD định mức dịch vụ (sử dụng useServiceQuotas)
    - `MetersPage.tsx` - CRUD đồng hồ công tơ (sử dụng useMeters)
    - _Yêu cầu: 31.2_

  - [x] 14.3 Tạo sub-pages Tài sản trong `src/pages/settings/categories/`
    - `SuppliersPage.tsx` - CRUD nhà cung cấp
    - `WarehousesPage.tsx` - CRUD kho tài sản (sử dụng useAssetWarehouses)
    - `AssetTypesPage.tsx` - CRUD loại tài sản
    - `AssetMovementsPage.tsx` - Xem lịch sử di chuyển tài sản
    - `AssetMaintenancePage.tsx` - Xem lịch sử sửa chữa tài sản
    - _Yêu cầu: 31.3_

  - [x] 14.4 Tạo sub-pages còn lại trong `src/pages/settings/categories/`
    - `HotlinesPage.tsx` - CRUD hotlines (sử dụng useHotlines)
    - `TaskTypesPage.tsx` - CRUD loại công việc (sử dụng useTaskTypes)
    - `GeneralCategoriesPage.tsx` - CRUD danh mục chung
    - `FloorsPage.tsx` - CRUD danh sách tầng (sử dụng useFloors)
    - _Yêu cầu: 31.4-31.7_

  - [ ]* 14.5 Viết unit tests cho CategoriesPage và sub-pages
    - Test render trang tổng hợp với đầy đủ links
    - Test CRUD operations trên 1-2 sub-pages đại diện
    - _Yêu cầu: 31.1-31.7_

- [x] 15. Tái cấu trúc Mẫu biểu
  - [x] 15.1 Cập nhật `src/pages/settings/TemplatesPage.tsx`
    - Hiển thị 6 loại mẫu biểu: Mẫu chữ ký, HĐ đặt cọc, HĐ thuê, BB bàn giao, Mẫu hóa đơn, Mẫu thu chi
    - Mỗi loại có CRUD: Tạo mới, Xem, Sửa, Xóa, Đặt mặc định
    - Sử dụng hook `useDocumentTemplates` (đã có) với type filter
    - Hỗ trợ template variables (JSONB) cho mỗi loại
    - _Yêu cầu: 32.1-32.6_

  - [ ]* 15.2 Viết unit tests cho TemplatesPage
    - Test render 6 loại mẫu biểu
    - Test filter theo type
    - _Yêu cầu: 32.1-32.6_

- [x] 16. Nâng cấp module Nhân viên
  - [x] 16.1 Cập nhật trang Nhân viên trong `src/pages/settings/`
    - Thêm quản lý Loại tài khoản (Roles) - CRUD roles với permissions JSONB
    - Cập nhật quản lý Người dùng: Thêm nhân viên, Thông tin cá nhân, Vai trò, Trạng thái
    - Hỗ trợ phân quyền theo module: Buildings, Contracts, Invoices, Reports, Settings
    - Hỗ trợ gán quyền theo toà nhà (sử dụng useStaffAssignments)
    - Sử dụng hooks useRoles và useStaffAssignments
    - _Yêu cầu: 33.1-33.4_

  - [ ]* 16.2 Viết unit tests cho Staff management
    - Test CRUD roles
    - Test phân quyền theo module
    - Test gán quyền theo toà nhà
    - _Yêu cầu: 33.1-33.4_

- [x] 17. Checkpoint - Kiểm tra Cài đặt và Danh mục khác
  - Đảm bảo tất cả trang cài đặt, danh mục khác, mẫu biểu, nhân viên hoạt động đúng. Hỏi user nếu có thắc mắc.

- [x] 18. Tạo trang Tài khoản (NEW)
  - [x] 18.1 Tạo `src/pages/account/ProfilePage.tsx`
    - Hiển thị và chỉnh sửa: Tên, Email, SĐT, Avatar
    - Chức năng đổi mật khẩu
    - Sử dụng hook `useProfile` (đã có) hoặc mở rộng
    - _Yêu cầu: 34.1_

  - [x] 18.2 Tạo `src/pages/account/SubscriptionPage.tsx`
    - Hiển thị gói cước hiện tại, hạn sử dụng
    - Danh sách gói cước có thể nâng cấp
    - Sử dụng hook useSubscription
    - _Yêu cầu: 34.2_

  - [ ]* 18.3 Viết unit tests cho Account pages
    - Test render ProfilePage với mock user data
    - Test render SubscriptionPage với mock plan data
    - _Yêu cầu: 34.1-34.2_

- [x] 19. Tạo trang Báo cáo BĐS
  - [x] 19.1 Tạo `src/pages/reports/real-estate/RealEstateReportsPage.tsx` - trang index
    - Hiển thị grid/list 8 loại báo cáo BĐS với link đến từng báo cáo
    - _Yêu cầu: 39.1_

  - [x] 19.2 Cập nhật/tạo báo cáo Căn hộ trống và Căn hộ sắp trống
    - Cập nhật tên "Phòng trống" → "Căn hộ trống" trong existing report
    - Cập nhật tên "Phòng sắp trống" → "Căn hộ sắp trống" trong existing report
    - Đảm bảo có bộ lọc theo toà nhà, tầng, khoảng thời gian
    - Đảm bảo có xuất Excel/PDF
    - _Yêu cầu: 20.1-20.3, 21.1-21.3_

  - [x] 19.3 Tạo `src/pages/reports/real-estate/RenewalsTransfersReport.tsx` (NEW)
    - Báo cáo phòng gia hạn, chuyển nhượng
    - Bộ lọc theo khoảng thời gian, toà nhà
    - Xuất Excel/PDF
    - _Yêu cầu: 22.1-22.3_

  - [x] 19.4 Tạo báo cáo Tỉ lệ lấp đầy - tách thành 2 trang
    - `src/pages/reports/real-estate/OccupancyOldReport.tsx` - Phiên bản cũ
    - `src/pages/reports/real-estate/OccupancyNewReport.tsx` - Phiên bản mới
    - Bộ lọc theo toà nhà, khoảng thời gian
    - Biểu đồ trend tỉ lệ lấp đầy theo tháng
    - _Yêu cầu: 23.1-23.4, 39.3_

  - [x] 19.5 Cập nhật báo cáo Khuyến mại, Cho thuê, Bỏ trả
    - Đảm bảo 3 báo cáo này tồn tại và có đầy đủ thông tin theo tài liệu
    - Khuyến mại: HĐ có giảm giá, Tổng giảm giá
    - Cho thuê: HĐ mới trong kỳ, Doanh thu mới
    - Bỏ trả: HĐ thanh lý, Lý do chấm dứt, Tỷ lệ bỏ trả
    - Xuất Excel/PDF cho tất cả
    - _Yêu cầu: 24.1-24.4_

- [x] 20. Tạo trang Báo cáo Tài chính
  - [x] 20.1 Tạo `src/pages/reports/finance/FinanceReportsPage.tsx` - trang index
    - Hiển thị grid/list 8 loại báo cáo Tài chính với link đến từng báo cáo
    - _Yêu cầu: 40.1_

  - [x] 20.2 Di chuyển Sổ quỹ sang Báo cáo Tài chính
    - Di chuyển logic từ `src/pages/cash-book/` sang `src/pages/reports/finance/DailyCashbookReport.tsx`
    - Hiển thị: Thu chi hàng ngày, Số dư đầu kỳ, Tổng thu, Tổng chi, Số dư cuối kỳ
    - Bộ lọc theo khoảng ngày, toà nhà
    - Xuất Excel/PDF
    - Sử dụng hook `useCashBook` (đã có)
    - _Yêu cầu: 25.1-25.3, 1.9_

  - [x] 20.3 Cập nhật/tạo báo cáo Dòng tiền và Phân bổ lợi nhuận
    - Đảm bảo báo cáo Dòng tiền tồn tại tại `/reports/finance/cash-flow`
    - Đảm bảo báo cáo Phân bổ lợi nhuận tồn tại tại `/reports/finance/profit-distribution`
    - Phân bổ lợi nhuận: Doanh thu, Chi phí, Lợi nhuận, Margin %
    - Bộ lọc theo khoảng thời gian, toà nhà
    - Xuất Excel/PDF
    - _Yêu cầu: 26.1-26.3, 27.1-27.3_

  - [x] 20.4 Cập nhật/tạo 5 báo cáo công nợ
    - Công nợ hợp đồng mới tại `/reports/finance/new-contract-debt`
    - Khách nợ tiền tại `/reports/finance/customer-debt`: Top debtors, Tổng công nợ, Phân loại theo mức độ
    - Lịch thanh toán tại `/reports/finance/payment-schedule`: HĐ cần thu trong tháng, Ngày đáo hạn, Số tiền
    - Tiền thừa tại `/reports/finance/overpayment`: Khách trả thừa, Cần hoàn lại
    - Danh sách tiền cọc tại `/reports/finance/deposits`: Tổng tiền cọc đang giữ, Phân theo trạng thái
    - Xuất Excel/PDF cho tất cả
    - _Yêu cầu: 28.1-28.6_

  - [ ]* 20.5 Viết unit tests cho báo cáo Tài chính
    - Test render trang index với 8 links
    - Test 1-2 báo cáo đại diện với mock data
    - _Yêu cầu: 40.1-40.2_

- [x] 21. Tạo trang Báo cáo Công việc
  - [x] 21.1 Tạo `src/pages/reports/tasks/TaskReportsPage.tsx` - trang index
    - Hiển thị grid/list 3 loại báo cáo Công việc
    - _Yêu cầu: 29.1_

  - [x] 21.2 Tạo 3 báo cáo Công việc
    - `TaskOverviewReport.tsx` - Tổng quan: Tổng số task, Hoàn thành, Đang xử lý, Quá hạn
    - `TaskByStaffReport.tsx` - Theo nhân viên: Assigned tasks, Performance, Completion rate
    - `TaskByApartmentReport.tsx` - Theo căn hộ: Sự cố theo phòng, Tần suất, Chi phí sửa chữa
    - Xuất Excel/PDF cho tất cả
    - _Yêu cầu: 29.1-29.4_

  - [ ]* 21.3 Viết unit tests cho báo cáo Công việc
    - Test render 3 báo cáo với mock data
    - _Yêu cầu: 29.1-29.4_

- [x] 22. Checkpoint - Kiểm tra tất cả báo cáo
  - Đảm bảo 8 báo cáo BĐS + 8 báo cáo Tài chính + 3 báo cáo Công việc hoạt động đúng, tên khớp SUMMARY.md. Hỏi user nếu có thắc mắc.

- [x] 23. Bổ sung tính năng Ký hợp đồng điện tử
  - [x] 23.1 Tích hợp ký điện tử vào trang Hợp đồng
    - Thêm section/tab ký điện tử trong `src/pages/contracts/`
    - Chỉ hiển thị khi setting `contract_e_signing_enabled = true`
    - Flow chủ nhà: Tạo HĐ → Gửi link ký → Theo dõi trạng thái
    - Flow khách thuê: Nhận link → Xem HĐ → Ký điện tử
    - Cập nhật `src/hooks/useContracts.ts` nếu cần thêm fields
    - _Yêu cầu: 12.6_

  - [ ]* 23.2 Viết unit tests cho e-signing flow
    - Test hiển thị/ẩn theo setting
    - Test flow gửi link ký
    - _Yêu cầu: 12.6_

- [x] 24. Mở rộng Code Generator
  - [x] 24.1 Cập nhật `src/lib/codeGenerator.ts`
    - Hỗ trợ 4 loại mã: Đặt cọc (DC-), Hợp đồng (HD-), Hóa đơn (INV-), Biên bản bàn giao (BBBG-)
    - Cấu hình: Tiền tố, Dấu phân cách, Format ngày, Số thứ tự, Padding, Reset period
    - Hỗ trợ reset counter theo: Ngày, Tháng, Năm, Không reset
    - _Yêu cầu: 35.1-35.3_

  - [ ]* 24.2 Viết unit tests cho codeGenerator
    - Test format output cho mỗi loại mã
    - Test reset counter logic
    - Test padding
    - _Yêu cầu: 35.1-35.3_

- [x] 25. UX Enhancements - Empty States, Tooltips, Breadcrumbs
  - [x] 25.1 Tạo/cập nhật EmptyState component
    - Tạo reusable `src/components/ui/EmptyState.tsx` nếu chưa có
    - Props: icon, title, description, actionLabel, onAction
    - Áp dụng vào tất cả trang danh sách: Toà nhà, Căn hộ, Giường, Dịch vụ, Tài sản, Khách hẹn, Đặt cọc, Hợp đồng, Khách hàng, Phương tiện, Hóa đơn, Thu chi, Công việc
    - Mỗi trang có message phù hợp (VD: "Chưa có toà nhà nào. Hãy thêm toà nhà đầu tiên")
    - _Yêu cầu: 37.3_

  - [x] 25.2 Cập nhật Breadcrumb navigation
    - Cập nhật `src/components/layout/Breadcrumbs.tsx` (hoặc tạo mới nếu chưa có)
    - Breadcrumb phản ánh đúng cấu trúc SUMMARY.md:
      - `Quản lý & Vận hành > Danh mục dữ liệu > Căn hộ`
      - `Cài đặt hệ thống > Danh mục khác > Tài chính > Tài khoản ngân hàng`
      - `Báo cáo > Báo cáo BĐS > Căn hộ trống`
    - Tích hợp breadcrumb vào tất cả trang
    - _Yêu cầu: 37.5_

  - [x] 25.3 Thêm placeholder text và tooltips
    - Thêm placeholder text hướng dẫn trong các form nhập liệu quan trọng
    - Đảm bảo tất cả toggles trong Cài đặt chung có tooltip mô tả
    - _Yêu cầu: 37.1, 37.2_

  - [ ]* 25.4 Viết unit tests cho EmptyState và Breadcrumbs
    - Test render EmptyState với các props khác nhau
    - Test breadcrumb paths cho các trang chính
    - _Yêu cầu: 37.3, 37.5_

- [x] 26. Onboarding Wizard cho người dùng mới
  - [x] 26.1 Tạo Onboarding Wizard component
    - Tạo `src/components/onboarding/OnboardingWizard.tsx`
    - Hiển thị sau đăng ký thành công hoặc đăng nhập lần đầu
    - Steps: Tạo toà nhà → Thêm phòng → Thêm dịch vụ → Tạo hợp đồng
    - Mỗi step có hướng dẫn và form tương ứng
    - Cho phép skip wizard
    - Lưu trạng thái đã hoàn thành wizard vào user settings
    - _Yêu cầu: 2.4, 37.4_

  - [ ]* 26.2 Viết unit tests cho OnboardingWizard
    - Test render wizard steps
    - Test navigation giữa các steps
    - Test skip functionality
    - _Yêu cầu: 2.4, 37.4_

- [x] 27. Bổ sung trang FAQ, Lịch sử cập nhật, và Hướng dẫn App
  - [x] 27.1 Tạo trang FAQ và Lịch sử cập nhật
    - Tạo `src/pages/FaqPage.tsx` - Trang FAQ theo tài liệu
    - Tạo `src/pages/ChangelogPage.tsx` - Trang lịch sử cập nhật
    - Thêm links trong footer hoặc phần "Thông tin khác"
    - _Yêu cầu: 42.1-42.3_

  - [x] 27.2 Thêm links hướng dẫn sử dụng App Resident
    - Thêm link/trang tham khảo hướng dẫn app cho chủ nhà
    - Thêm link/trang tham khảo hướng dẫn app cho khách thuê
    - Có thể đặt trong footer, help menu, hoặc trang riêng
    - _Yêu cầu: 41.1-41.2_

- [x] 28. Tích hợp và kiểm tra toàn bộ
  - [x] 28.1 Kiểm tra tất cả routes hoạt động và không có broken links
    - Duyệt qua tất cả routes trong App.tsx
    - Đảm bảo mỗi route có component tương ứng
    - Đảm bảo redirects từ URL cũ hoạt động
    - _Yêu cầu: 1.1-1.11_

  - [x] 28.2 Kiểm tra Sidebar khớp 100% với SUMMARY.md
    - So sánh từng mục menu với SUMMARY.md
    - Đảm bảo thứ tự, tên, icon đúng
    - Đảm bảo không còn mục đã xóa (Areas, AI, Duyệt thanh lý)
    - _Yêu cầu: 1.1-1.11_

  - [x] 28.3 Kiểm tra thuật ngữ toàn bộ ứng dụng
    - Grep codebase đảm bảo không còn "Phòng" (ngoài tên bảng DB), "Sự cố", "Leads", "Tổng quan" (cho Dashboard), "Master Data"
    - Đảm bảo tất cả thông báo bằng tiếng Việt chuẩn
    - _Yêu cầu: 36.1-36.8_

  - [x] 28.4 Đảm bảo tất cả trang có breadcrumb và empty state
    - Kiểm tra breadcrumb hiển thị đúng trên mỗi trang
    - Kiểm tra empty state hiển thị khi danh sách trống
    - _Yêu cầu: 37.3, 37.5_

- [x] 29. Checkpoint cuối - Đảm bảo tất cả tests pass
  - Đảm bảo tất cả tests pass, ứng dụng compile không lỗi, tất cả routes hoạt động. Hỏi user nếu có thắc mắc.

## Ghi chú

- Các task đánh dấu `*` là optional, có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến yêu cầu cụ thể để đảm bảo traceability
- Checkpoints giúp kiểm tra tiến độ tại các mốc quan trọng
- Thứ tự thực hiện: Database → Xóa module → Routing → Sidebar → Thuật ngữ → Trang mới → Báo cáo → Cài đặt → UX
- Tên bảng DB giữ nguyên (rooms, issues), chỉ đổi UI labels
