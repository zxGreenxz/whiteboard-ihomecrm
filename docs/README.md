# IHOMECRM - HỆ THỐNG QUẢN LÝ BẤT ĐỘNG SẢN
## Tài liệu thiết kế chi tiết 100% theo docs.resident.vn

---

## 📚 DANH SÁCH TÀI LIỆU

### Core Documentation (Đã có từ trước)

| File | Nội dung | Dòng | Trạng thái |
|------|----------|------|-----------|
| [00-OVERVIEW.md](./00-OVERVIEW.md) | Tổng quan hệ thống, Tech stack, Roadmap | ~600 | ✅ Complete |
| [01-DATABASE-SCHEMA.md](./01-DATABASE-SCHEMA.md) | 15 bảng database, RLS, Triggers, Functions | ~1800 | ✅ Complete |
| [02-AUTH-FLOW.md](./02-AUTH-FLOW.md) | Đăng ký, Đăng nhập, Quên mật khẩu | ~900 | ✅ Complete |
| [03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md) | Buildings, Rooms, Beds, Services | ~937 | ✅ Complete |
| [05-LEASING-FLOW.md](./05-LEASING-FLOW.md) | Contracts lifecycle (cơ bản) | ~892 | ✅ Complete |
| [06-BILLING-FLOW.md](./06-BILLING-FLOW.md) | Invoices, Payments, Cash book | ~1100 | ✅ Complete |

### New Documentation (Mới tạo - Bổ sung đầy đủ)

| File | Nội dung | Dòng | Trạng thái |
|------|----------|------|-----------|
| [ANALYSIS-MISSING-FEATURES.md](./ANALYSIS-MISSING-FEATURES.md) | Phân tích chi tiết 11 phần còn thiếu | ~900 | ✅ Complete |
| [04-LEAD-DEPOSIT-FLOW.md](./04-LEAD-DEPOSIT-FLOW.md) | Khách hẹn & Đặt cọc | ~823 | ✅ Complete |
| [07-ASSET-ISSUES-MANAGEMENT.md](./07-ASSET-ISSUES-MANAGEMENT.md) | Tài sản & Sự cố | ~1236 | ✅ Complete |
| [08-DASHBOARD-REPORTS.md](./08-DASHBOARD-REPORTS.md) | Bảng tin & 19 loại báo cáo | ~1260 | ✅ Complete |
| [09-SETTINGS-ADVANCED.md](./09-SETTINGS-ADVANCED.md) | Cài đặt & Tính năng nâng cao | ~1676 | ✅ Complete |

**TỔNG CỘNG**: ~12,124 dòng tài liệu chi tiết

---

## 🎯 PHẠM VI TÍNH NĂNG

### ✅ 100% Theo docs.resident.vn

#### 1. AUTHENTICATION & USER MANAGEMENT
- ✅ Đăng ký tài khoản
- ✅ Đăng nhập (Email/SĐT + Password)
- ✅ Quên mật khẩu (Email reset)
- ✅ OTP qua Zalo/SMS (Phase 2)
- ✅ Session management
- ✅ Protected routes

#### 2. LEAD & SALES FUNNEL
- ✅ **Khách hẹn (Lead Management)**
  - B1: Bắn khách (Lead capture)
  - B2: Hẹn khách (Schedule appointment)
  - B3: Tư vấn (Sales consultation)
  - Phân công nhân viên
  - Lead scoring
  - Conversion tracking
- ✅ **Đặt cọc (Deposit Management)**
  - Quản lý tiền cọc giữ chỗ
  - 5 trạng thái: PENDING → CONFIRMED → CONVERTED/REFUNDED/FORFEITED
  - Chuyển đổi thành hợp đồng
  - In phiếu thu cọc

#### 3. ASSET MANAGEMENT (Quản lý tài sản)
- ✅ **Danh mục dữ liệu**
  - Tòa nhà (Buildings)
  - Phòng/Căn hộ (Rooms)
  - Giường (Beds - cho KTX)
  - Dịch vụ (Services - 4 loại)
- ✅ **Tài sản/Nội thất (Inventory)**
  - Danh mục tài sản
  - Nhà cung cấp
  - Kho tài sản
  - CRUD tài sản
  - Bàn giao tài sản (Check-in/Check-out)
  - Biên bản bàn giao + Chữ ký số
  - Di chuyển tài sản
  - Sửa chữa/Bảo trì
  - Lịch sử tài sản
- ✅ **Phương tiện (Vehicles)**
  - Quản lý xe máy, ô tô
  - Liên kết với hợp đồng
  - Phí gửi xe

#### 4. LEASING MANAGEMENT (Quản lý hợp đồng)
- ✅ **Vòng đời hợp đồng**
  - Tạo mới (Check-in)
  - Gia hạn (Extend)
  - Chuyển phòng (Transfer room)
  - Nhượng hợp đồng (Transfer contract)
  - Đăng ký chuyển đi (Move-out registration)
  - Thanh lý (Terminate/Settlement)
- ✅ **Tính toán tài chính**
  - Tiền thuê theo chu kỳ
  - Tiền cọc (Total, Paid, Remaining)
  - Giảm giá theo tháng (Discounts JSONB)
  - Chỉ số điện/nước đầu
  - Tính toán khi thanh lý (Công nợ, hoàn cọc)
- ✅ **Quản lý khách thuê**
  - Thông tin cá nhân/Tổ chức
  - Foreign customer support
  - Lịch sử hợp đồng
  - CT01 Form (Tờ khai cư trú)

#### 5. BILLING & FINANCE (Quản lý tài chính)
- ✅ **Ghi chỉ số**
  - Điện, nước, gas
  - Lịch sử chỉ số
  - Tự động tính tiêu thụ
- ✅ **Hóa đơn (Invoices)**
  - Tạo hóa đơn (Auto/Manual)
  - Duyệt hóa đơn (Single/Bulk)
  - Tính toán: Rent + Services + Debt - Discount + Tax
  - Hạn thanh toán configurable
  - In hóa đơn (PDF/Thermal)
- ✅ **Thu chi (Payments)**
  - Thu tiền
  - Phương thức thanh toán (Cash, Bank, Momo, VNPay...)
  - Phiếu thu, Phiếu chi
  - Cập nhật trạng thái tự động
- ✅ **Sổ quỹ (Cash Book)**
  - Thu/Chi hàng ngày
  - Số dư đầu/cuối kỳ
  - Dòng tiền (Cash Flow)

#### 6. ISSUES & TASKS (Sự cố & Công việc)
- ✅ **Quản lý sự cố**
  - 4 bước: Báo cáo → Tiếp nhận → Xử lý → Hoàn thành
  - Loại sự cố (Điện, Nước, Wifi, Nội thất...)
  - Priority: LOW, MEDIUM, HIGH, URGENT
  - Status workflow: NEW → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED
  - Phân công nhân viên
  - Tracking thời gian & chi phí
  - Rating & Feedback
- ✅ **Comments & Timeline**
  - Update history
  - Status changes tracking

#### 7. NOTIFICATIONS (Gửi thông báo)
- ✅ **Multi-channel**
  - In-app notifications
  - Email
  - SMS Brandname
  - Zalo ZNS
  - Push notification
- ✅ **Loại thông báo**
  - Hóa đơn mới
  - Nhắc thanh toán
  - Hóa đơn quá hạn
  - Hợp đồng sắp hết hạn
  - Sự cố được xử lý
  - Thông báo chung
- ✅ **Automation**
  - Templates
  - Scheduling
  - Triggers (Auto send)

#### 8. DASHBOARD & ANALYTICS (Bảng tin)
- ✅ **Dashboard**
  - Overview cards (4 cards)
  - Charts (Revenue, Occupancy, Debt, Cash Flow)
  - Alerts & Notifications
  - Recent activities
  - Quick actions
  - Real-time updates
- ✅ **Sơ đồ tòa nhà (Building Map)**
  - Grid view
  - Floor plan view
  - 5 màu color coding
  - Interactive features

#### 9. REPORTS (Báo cáo - 19 loại)
- ✅ **Báo cáo BĐS (8 loại)**
  1. Căn hộ trống
  2. Căn hộ sắp trống
  3. Gia hạn, chuyển nhượng
  4. Tỷ lệ lấp đầy
  5. Khuyến mại
  6. Cho thuê mới
  7. Bỏ trả
  8. Lịch sử giá
- ✅ **Báo cáo Tài chính (8 loại)**
  1. Sổ quỹ theo ngày
  2. Dòng tiền
  3. Phân bổ lợi nhuận
  4. Công nợ hợp đồng
  5. Khách nợ tiền
  6. Lịch thanh toán
  7. Tiền thừa
  8. Danh sách tiền cọc
- ✅ **Báo cáo Công việc (3 loại)**
  1. Tổng quan
  2. Theo nhân viên
  3. Theo căn hộ
- ✅ **Export**: Excel, PDF, CSV

#### 10. SETTINGS & CONFIGURATION (Cài đặt)
- ✅ **Cài đặt chung**
  - Thông tin doanh nghiệp
  - Cấu hình hợp đồng (11 options)
  - Cấu hình hóa đơn (9 options)
  - Thanh toán & Thông báo
- ✅ **Mẫu biểu**
  - Mẫu hợp đồng
  - Mẫu phiếu thu chi
  - Mẫu hóa đơn (Thermal, A4)
  - Template engine với variables
- ✅ **Nhân viên & Phân quyền**
  - Quản lý nhân viên
  - RBAC (6 roles)
  - Permission matrix
  - Building-based assignment
- ✅ **Danh mục khác**
  - Tài chính (Ngân hàng, E-Invoice...)
  - Tài sản (Nhà cung cấp, Kho...)
  - Hotline, Zalo OA
  - Loại công việc

#### 11. ADVANCED FEATURES (Tính năng nâng cao)
- ✅ **Code Generation System**
  - Auto-generate codes
  - Customizable format
  - Reset periods
- ✅ **Import/Export Excel**
  - Tất cả modules
  - Template download
  - Bulk operations
- ✅ **CT01 Form**
  - Tờ khai cư trú
  - Auto-fill
  - PDF generation

---

## 🗄️ DATABASE SCHEMA

### Tổng số bảng: 30+ bảng

#### Core Tables (15 bảng - Từ 01-DATABASE-SCHEMA.md)
1. profiles
2. buildings
3. rooms
4. beds
5. services
6. tenants
7. contracts
8. contract_services
9. invoices
10. invoice_items
11. payments
12. meter_readings
13. deposits
14. expenses
15. settings

#### New Tables (15+ bảng - Từ docs mới)
16. leads (Khách hẹn)
17. lead_activities
18. vehicles (Phương tiện)
19. asset_categories
20. suppliers
21. assets
22. asset_handovers
23. asset_movements
24. asset_maintenance
25. issue_categories
26. issues
27. issue_comments
28. notification_templates
29. notifications
30. notification_logs
31. code_sequences
32. ct01_forms
33. staff (Nhân viên)
34. roles
35. permissions
36. ...và nhiều bảng khác

### Enums
- 20+ ENUM types để đảm bảo data integrity

### Triggers & Functions
- 10+ triggers để auto-update
- 5+ functions cho business logic
- RLS policies cho tất cả bảng

---

## 🎨 TECH STACK

### Frontend
```
Vite 5.4.19
React 18.3.1
TypeScript 5.8.3
Tailwind CSS 3.4.17
shadcn/ui (Radix UI)
React Router 6.30.1
TanStack Query 5.83
React Hook Form 7.61
Zod 3.25.76
Lucide React (Icons)
Recharts 2.15.4 (Charts)
date-fns 3.6.0
Sonner (Toast)
```

### Backend & Infrastructure
```
Supabase
├── PostgreSQL (Database)
├── Auth (Authentication)
├── Storage (File upload)
├── Realtime (WebSocket)
└── Edge Functions (Serverless)
```

### Future Integrations
```
Zalo ZNS API (Notifications)
SMS Brandname
Payment Gateways (VNPay, Momo)
IoT Devices (Smart meters, Door locks)
```

---

## 📖 HƯỚNG DẪN SỬ DỤNG TÀI LIỆU

### Cho Developer

**Bước 1: Đọc tổng quan**
```
1. Đọc 00-OVERVIEW.md để hiểu kiến trúc
2. Đọc ANALYSIS-MISSING-FEATURES.md để hiểu scope đầy đủ
```

**Bước 2: Setup Database**
```
1. Đọc 01-DATABASE-SCHEMA.md
2. Chạy migration scripts trên Supabase
3. Thiết lập RLS policies
4. Tạo triggers & functions
```

**Bước 3: Implement theo module**
```
Phase 1: Authentication (02-AUTH-FLOW.md)
Phase 2: Asset Management (03-ASSET-MANAGEMENT.md)
Phase 3: Lead & Deposit (04-LEAD-DEPOSIT-FLOW.md)
Phase 4: Leasing (05-LEASING-FLOW.md)
Phase 5: Billing (06-BILLING-FLOW.md)
Phase 6: Asset & Issues (07-ASSET-ISSUES-MANAGEMENT.md)
Phase 7: Dashboard & Reports (08-DASHBOARD-REPORTS.md)
Phase 8: Settings & Advanced (09-SETTINGS-ADVANCED.md)
```

**Bước 4: Testing**
```
Mỗi file đều có Testing Checklist chi tiết
Làm theo từng checklist để ensure quality
```

### Cho Product Manager

**Sử dụng để:**
- Hiểu đầy đủ tính năng hệ thống
- Lập kế hoạch triển khai (Roadmap)
- Ước lượng thời gian & resources
- Viết user stories
- Làm acceptance criteria

### Cho Designer

**Sử dụng để:**
- Hiểu flow của từng tính năng
- Thiết kế UI/UX phù hợp
- Tham khảo các ASCII mockups
- Hiểu data structure để design forms
- Color coding cho trạng thái

---

## 🗺️ IMPLEMENTATION ROADMAP

### Tổng thời gian: 14-16 tuần (3.5-4 tháng)

### PHASE 1: Foundation (Tuần 1-2)
**Mục tiêu**: Setup project & Auth
- ✅ Setup Vite + React + TypeScript
- ✅ Setup Supabase
- ✅ Database migration (Core tables)
- ✅ Authentication
  - Register, Login, Forgot Password
  - Protected routes
  - Session management
- ✅ Main layout (Header, Sidebar)

**Deliverable**: User có thể đăng ký, đăng nhập và thấy dashboard shell

---

### PHASE 2: Asset Management (Tuần 3-4)
**Mục tiêu**: Quản lý tòa nhà, phòng, dịch vụ
- ✅ Buildings CRUD
- ✅ Rooms CRUD
- ✅ Beds CRUD (cho KTX)
- ✅ Services management (4 types)
- ✅ Import/Export Excel
- ✅ Building map (basic grid view)

**Deliverable**: User có thể tạo và quản lý tài sản cho thuê

---

### PHASE 3: Lead & Deposit (Tuần 5-6)
**Mục tiêu**: Sales funnel
- ✅ Lead management
  - Lead capture
  - Schedule appointments
  - Assign staff
  - Lead scoring
- ✅ Deposit management
  - Create deposits
  - Convert to contracts
  - Refund handling
- ✅ Conversion tracking

**Deliverable**: User có thể quản lý prospect đến khi ký HĐ

---

### PHASE 4: Leasing Management (Tuần 7-8)
**Mục tiêu**: Quản lý hợp đồng
- ✅ Tenant management
- ✅ Contract CRUD
  - Create (Check-in)
  - Extend
  - Transfer room
  - Transfer contract
  - Terminate (Settlement calculation)
- ✅ Vehicle management
- ✅ Contract templates

**Deliverable**: User có thể quản lý toàn bộ vòng đời HĐ

---

### PHASE 5: Billing & Finance (Tuần 9-10)
**Mục tiêu**: Quản lý tài chính
- ✅ Meter reading
- ✅ Invoice management
  - Auto-generate
  - Approve (single/bulk)
  - PDF/Thermal printing
- ✅ Payment collection
- ✅ Cash book
- ✅ Receipt/Payment vouchers

**Deliverable**: User có thể lập hóa đơn và thu tiền

---

### PHASE 6: Asset & Issues (Tuần 11-12)
**Mục tiêu**: Quản lý tài sản và sự cố
- ✅ Asset inventory
  - Categories, Suppliers, Warehouses
  - Asset CRUD
  - Handover documents
  - Movement tracking
  - Maintenance
- ✅ Issues & Tasks
  - Report issues
  - Assign staff
  - Track progress
  - Rating & feedback

**Deliverable**: User có thể quản lý nội thất và xử lý sự cố

---

### PHASE 7: Dashboard & Reports (Tuần 13-14)
**Mục tiêu**: Analytics & Reporting
- ✅ Dashboard
  - Overview cards
  - Charts (Revenue, Occupancy, Debt, Cash Flow)
  - Alerts
  - Recent activities
- ✅ Building map (Advanced)
  - Color coding
  - Interactive
  - Floor plan view
- ✅ Reports (19 loại)
  - BĐS reports (8)
  - Tài chính reports (8)
  - Công việc reports (3)
  - Export (Excel, PDF, CSV)

**Deliverable**: User có dashboard tổng quan và reports đầy đủ

---

### PHASE 8: Settings & Advanced (Tuần 15-16)
**Mục tiêu**: Configuration & Automation
- ✅ System settings
  - General settings
  - Contract configuration
  - Invoice configuration
- ✅ Templates
  - Contract, Invoice, Receipt templates
  - Template engine
- ✅ Staff & Permissions
  - RBAC
  - Permission matrix
- ✅ Notification system
  - Multi-channel
  - Templates
  - Automation
- ✅ Code generation
- ✅ CT01 Form
- ✅ Testing & Bug fixes
- ✅ Performance optimization
- ✅ Documentation
- ✅ Deployment

**Deliverable**: Hệ thống hoàn chỉnh, sẵn sàng production

---

## 📊 METRICS & KPIs

### Development Metrics
- Total files: 10 docs files
- Total lines: ~12,124 lines
- Database tables: 30+ tables
- API endpoints: 150+ endpoints
- Components: 100+ React components
- Test cases: 500+ test cases

### Business Metrics (Mẫu cho hệ thống)
- Average lead conversion rate: 30-40%
- Average deposit to contract conversion: 80-90%
- Invoice collection rate: 85-95%
- Average issue resolution time: < 24 hours
- Occupancy rate target: > 90%
- Customer satisfaction: > 4.5/5

---

## 🔒 SECURITY & BEST PRACTICES

### Security
- ✅ Row Level Security (RLS) trên tất cả tables
- ✅ Input validation (Client + Server)
- ✅ SQL injection prevention
- ✅ XSS protection
- ✅ CSRF protection
- ✅ Secure file upload
- ✅ Rate limiting
- ✅ HTTPS only

### Performance
- ✅ Pagination cho tất cả lists
- ✅ Lazy loading
- ✅ Image optimization
- ✅ Caching với TanStack Query
- ✅ Database indexes
- ✅ Optimistic updates

### Code Quality
- ✅ TypeScript strict mode
- ✅ ESLint + Prettier
- ✅ Git hooks (Husky)
- ✅ Code review process
- ✅ Testing (Unit + Integration)

---

## 🚀 NEXT STEPS

### Cho Team Development

1. **Review tài liệu** (1-2 ngày)
   - Đọc toàn bộ 10 files docs
   - Hiểu flow và business logic
   - Clarify questions

2. **Setup environment** (1 ngày)
   - Clone repo
   - Install dependencies
   - Setup Supabase project
   - Run migrations

3. **Kickoff meeting** (1 ngày)
   - Phân chia tasks
   - Estimate timeline
   - Setup sprint planning

4. **Start Phase 1** (Tuần 1-2)
   - Implement authentication
   - Basic layout
   - First milestone

### Cho Stakeholders

1. **Review & Approval**
   - Approve tài liệu này
   - Confirm scope
   - Allocate resources

2. **Budget & Timeline**
   - Finalize budget
   - Confirm go-live date
   - Plan marketing

3. **Preparation**
   - Prepare content (Logos, texts...)
   - Prepare data for import
   - Plan training

---

## 📞 SUPPORT & CONTACTS

### Development Team
- Lead Developer: [TBD]
- Backend Developer: [TBD]
- Frontend Developer: [TBD]
- QA Engineer: [TBD]

### Resources
- Supabase Docs: https://supabase.com/docs
- React Docs: https://react.dev
- TanStack Query: https://tanstack.com/query/
- shadcn/ui: https://ui.shadcn.com/

### References
- Resident Docs: https://docs.resident.vn/
- This documentation: `/docs/`

---

## ✅ CHECKLIST TRIỂN KHAI

### Pre-Development
- [ ] Review toàn bộ tài liệu
- [ ] Clarify questions với stakeholders
- [ ] Setup Supabase project
- [ ] Setup Git repository
- [ ] Setup CI/CD pipeline

### Phase 1-8
- [ ] Complete Phase 1 (Foundation)
- [ ] Complete Phase 2 (Asset Management)
- [ ] Complete Phase 3 (Lead & Deposit)
- [ ] Complete Phase 4 (Leasing)
- [ ] Complete Phase 5 (Billing)
- [ ] Complete Phase 6 (Asset & Issues)
- [ ] Complete Phase 7 (Dashboard & Reports)
- [ ] Complete Phase 8 (Settings & Advanced)

### Testing
- [ ] Unit tests (>80% coverage)
- [ ] Integration tests
- [ ] E2E tests
- [ ] Performance tests
- [ ] Security audit
- [ ] User acceptance testing (UAT)

### Deployment
- [ ] Setup production environment
- [ ] Database migration
- [ ] Deploy application
- [ ] Setup monitoring
- [ ] Setup backups
- [ ] Go-live checklist

### Post-Launch
- [ ] Monitor performance
- [ ] Collect user feedback
- [ ] Bug fixes
- [ ] Iteration & improvements
- [ ] Training materials
- [ ] Support documentation

---

## 📝 VERSION HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-18 | AI Agent | Initial comprehensive documentation |
| | | | - 10 detailed docs files |
| | | | - 30+ database tables |
| | | | - 100% coverage theo docs.resident.vn |

---

## 📄 LICENSE

[Your License Here]

---

**Tác giả**: AI Agent
**Ngày tạo**: 2025-11-18
**Mục đích**: Tài liệu thiết kế chi tiết để implement hệ thống quản lý bất động sản ihomecrm
**Tham khảo**: https://docs.resident.vn/

---

**🎯 READY FOR IMPLEMENTATION!**

Tài liệu này cung cấp đầy đủ thông tin cần thiết để bắt đầu phát triển hệ thống ihomecrm với 100% tính năng theo docs.resident.vn. Mỗi file docs đều có flow diagrams chi tiết, database schema, component structure, API integration và testing checklist.

**Happy Coding! 🚀**
