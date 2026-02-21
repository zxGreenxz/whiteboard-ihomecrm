# TỔNG QUAN HỆ THỐNG IHOMECRM
## Quản Lý Bất Động Sản - Phòng Trọ

---

## 📋 MỤC LỤC

1. [Giới thiệu](#giới-thiệu)
2. [Tech Stack](#tech-stack)
3. [Kiến trúc hệ thống](#kiến-trúc-hệ-thống)
4. [Các phân hệ chính](#các-phân-hệ-chính)
5. [Cấu trúc dữ liệu](#cấu-trúc-dữ-liệu)
6. [Flow tổng quan](#flow-tổng-quan)
7. [Roadmap triển khai](#roadmap-triển-khai)
8. [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 🎯 GIỚI THIỆU

### Mục tiêu dự án
Xây dựng hệ thống quản lý bất động sản cho thuê (phòng trọ, chung cư, homestay, KTX) với đầy đủ tính năng:
- Quản lý tài sản (Building > Room > Bed)
- Quản lý hợp đồng và khách thuê
- Quản lý tài chính và hóa đơn
- Báo cáo và thống kê
- Tự động hóa quy trình

### Đặc điểm nổi bật
- ✅ **Đa mô hình**: Hỗ trợ nhà trọ, chung cư, KTX, homestay, văn phòng
- ✅ **Phân cấp tài sản**: Building → Room → Bed (linh hoạt theo mô hình)
- ✅ **Tự động hóa**: Tạo hóa đơn tự động, nhắc nợ, thông báo
- ✅ **Báo cáo thời gian thực**: Dashboard, biểu đồ, thống kê
- ✅ **Import/Export Excel**: Nhập hàng loạt, xuất báo cáo
- ✅ **Tích hợp IoT**: Sẵn sàng kết nối công tơ điện, khóa vân tay (future)

---

## 🛠️ TECH STACK

### Frontend
```
- Vite 5.4.19          → Build tool & dev server
- React 18.3.1         → UI library
- TypeScript 5.8.3     → Type safety
- Tailwind CSS 3.4.17  → Styling framework
- shadcn/ui            → Component library (Radix UI)
- React Router 6.30.1  → Client-side routing
- TanStack Query 5.83  → Server state management
- React Hook Form 7.61 → Form management
- Zod 3.25.76          → Schema validation
- Lucide React 0.462   → Icons
- Recharts 2.15.4      → Charts & visualization
- date-fns 3.6.0       → Date manipulation
- Sonner 1.7.4         → Toast notifications
```

### Backend & Infrastructure
```
- Supabase             → Backend as a Service
  ├── PostgreSQL       → Database
  ├── Auth             → Authentication
  ├── Storage          → File storage
  ├── Realtime         → Websocket subscriptions
  └── Edge Functions   → Serverless functions

- Future integrations:
  ├── Zalo ZNS API     → Push notifications
  ├── SMS Brandname    → SMS notifications
  └── Payment Gateway  → Online payments (VNPay, Momo)
```

---

## 🏗️ KIẾN TRÚC HỆ THỐNG

### Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT LAYER                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Web App    │  │  Mobile App  │  │  Tenant App  │      │
│  │  (React TS)  │  │   (Future)   │  │   (Future)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   API LAYER (Supabase)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Auth API    │  │ Database API │  │ Storage API  │      │
│  │  (RLS)       │  │  (PostgREST) │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   DATA LAYER                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              PostgreSQL Database                      │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐        │   │
│  │  │ Users  │ │ Assets │ │Contracts│ │Invoices│        │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              EXTERNAL INTEGRATIONS (Future)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Zalo ZNS │  │   SMS    │  │ Payment  │  │   IoT    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Kiến trúc Frontend

```
src/
├── main.tsx                    # Entry point
├── App.tsx                     # Root component + routing
├── pages/                      # Page components
│   ├── auth/                   # Authentication pages
│   │   ├── Login.tsx
│   │   ├── Register.tsx
│   │   └── ForgotPassword.tsx
│   ├── dashboard/              # Dashboard & analytics
│   │   └── Dashboard.tsx
│   ├── assets/                 # Asset management
│   │   ├── Buildings.tsx
│   │   ├── Rooms.tsx
│   │   └── Beds.tsx
│   ├── leasing/                # Contract management
│   │   ├── Contracts.tsx
│   │   ├── Tenants.tsx
│   │   └── ContractDetail.tsx
│   ├── billing/                # Financial management
│   │   ├── Invoices.tsx
│   │   ├── Payments.tsx
│   │   └── CashFlow.tsx
│   └── settings/               # Settings & configuration
│       ├── Services.tsx
│       ├── Templates.tsx
│       └── Profile.tsx
├── components/                 # Reusable components
│   ├── ui/                     # shadcn/ui components
│   ├── layout/                 # Layout components
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   └── MainLayout.tsx
│   ├── forms/                  # Form components
│   ├── tables/                 # Table components
│   └── charts/                 # Chart components
├── hooks/                      # Custom React hooks
│   ├── useAuth.ts
│   ├── useBuildings.ts
│   ├── useContracts.ts
│   └── useInvoices.ts
├── lib/                        # Utilities & configurations
│   ├── supabase.ts             # Supabase client
│   ├── utils.ts                # Helper functions
│   └── constants.ts            # Constants
└── types/                      # TypeScript types
    ├── database.ts             # Supabase generated types
    ├── models.ts               # Domain models
    └── api.ts                  # API types
```

---

## 📦 CÁC PHÂN HỆ CHÍNH

### 1. PHÂN HỆ XÁC THỰC (Authentication)
```
📄 Tài liệu chi tiết: docs/02-AUTH-FLOW.md

Chức năng:
├── Đăng ký tài khoản
├── Đăng nhập
├── Quên mật khẩu (OTP qua Zalo/SMS)
├── Quản lý phiên đăng nhập
└── Phân quyền (Role-based access)

Tech:
└── Supabase Auth + Row Level Security (RLS)
```

### 2. PHÂN HỆ QUẢN LÝ TÀI SẢN (Asset Management)
```
📄 Tài liệu chi tiết:
   - docs/03-ASSET-MANAGEMENT.md
   - docs/04-SERVICE-MANAGEMENT.md

Cấu trúc phân cấp:
├── Building (Tòa nhà)
│   ├── Thông tin: Tên, địa chỉ (Tỉnh/Quận/Phường), trạng thái
│   ├── Cấu hình: Số tầng, loại hình
│   └── Rooms (Phòng)
│       ├── Thông tin: Tên, tầng, diện tích
│       ├── Giá: Tiền thuê, tiền cọc
│       ├── Cấu hình: Số khách tối đa
│       └── Beds (Giường - cho KTX/Sleepbox)
│           ├── Thông tin: Tên giường
│           └── Giá: Tiền thuê, tiền cọc

Services (Dịch vụ):
├── Loại dịch vụ:
│   ├── Cố định (Fixed)
│   ├── Theo người (Per Person)
│   ├── Theo phòng (Per Room)
│   └── Theo chỉ số (Meter Reading)
└── Ví dụ: Điện, nước, wifi, vệ sinh, giữ xe...

Tính năng:
├── CRUD tòa nhà, phòng, giường
├── Import hàng loạt từ Excel
├── Quản lý trạng thái (Active/Inactive)
└── Sơ đồ tòa nhà (Building map)
```

### 3. PHÂN HỆ QUẢN LÝ HỢP ĐỒNG (Leasing)
```
📄 Tài liệu chi tiết: docs/05-LEASING-FLOW.md

Vòng đời hợp đồng:
├── 1. Tạo mới (Check-in)
│   ├── Chọn phòng/giường
│   ├── Thông tin khách thuê
│   ├── Thông tin hợp đồng (ngày ký, ngày bắt đầu, hạn)
│   ├── Tài chính (tiền thuê, tiền cọc, chu kỳ thanh toán)
│   ├── Dịch vụ đăng ký
│   └── Giảm giá (nếu có)
├── 2. Gia hạn
│   ├── Nhập số tháng gia hạn
│   └── Cập nhật giá thuê mới
├── 3. Chuyển phòng
│   ├── Chọn phòng mới
│   ├── Cập nhật giá thuê, dịch vụ
│   └── Kết thúc hợp đồng cũ
├── 4. Nhượng hợp đồng
│   ├── Thay thế thông tin khách
│   └── Giữ nguyên hoặc cập nhật hạn
└── 5. Thanh lý (Check-out)
    ├── Chọn lý do (Rời phòng/Bỏ cọc)
    ├── Nhập ngày chuyển đi
    ├── Tính toán:
    │   ├── Công nợ cũ
    │   ├── Tiền phòng chưa trả
    │   ├── Hoàn trả cọc
    │   └── Phí phạt/hư hỏng
    └── Kết quả: Thu thêm hoặc Trả lại

Quản lý khách thuê:
├── Thông tin cá nhân (Họ tên, CCCD, SĐT, Email)
├── Lịch sử hợp đồng
└── Lịch sử thanh toán
```

### 4. PHÂN HỆ TÀI CHÍNH (Billing & Finance)
```
📄 Tài liệu chi tiết: docs/06-BILLING-FLOW.md

Quy trình hàng tháng:
├── 1. Ghi chỉ số điện/nước
│   ├── Nhập chỉ số mới
│   ├── Tự động tính tiêu thụ = Mới - Cũ
│   └── Lưu lịch sử chỉ số
├── 2. Lập hóa đơn
│   ├── Tự động: Tạo hàng loạt cho kỳ thanh toán
│   ├── Thủ công: Tạo từng hóa đơn
│   ├── Tính toán:
│   │   ├── Tiền phòng (theo chu kỳ)
│   │   ├── Tiền dịch vụ (điện, nước...)
│   │   ├── Công nợ cũ
│   │   ├── Giảm giá
│   │   └── Tổng cộng
│   └── Hạn thanh toán = Ngày lập + 5 ngày (configurable)
├── 3. Duyệt hóa đơn
│   ├── Duyệt từng hóa đơn
│   ├── Duyệt hàng loạt (Bulk approve)
│   └── Gửi thông báo tự động (Zalo/SMS)
├── 4. Thu tiền
│   ├── Nhập số tiền thực thu
│   ├── Lưu vào sổ quỹ
│   ├── Cập nhật trạng thái:
│   │   ├── Đã thanh toán (Paid)
│   │   ├── Thanh toán một phần (Partial)
│   │   └── Chưa thanh toán (Unpaid)
│   └── Tính công nợ còn lại
└── 5. In/Xuất hóa đơn
    ├── PDF
    ├── Excel
    └── In nhiệt

Sổ quỹ (Cash Book):
├── Thu (Revenue)
│   ├── Tiền phòng
│   ├── Tiền dịch vụ
│   └── Thu khác
├── Chi (Expense)
│   ├── Sửa chữa
│   ├── Bảo trì
│   └── Chi khác
└── Báo cáo dòng tiền (Cash Flow)

Báo cáo:
├── Doanh thu theo tháng/quý/năm
├── Công nợ
├── Khách nợ tiền
├── Lịch thanh toán
└── Phân bổ lợi nhuận
```

### 5. PHÂN HỆ BÁO CÁO & THỐNG KÊ (Reports & Analytics)
```
Dashboard:
├── Tổng quan
│   ├── Tổng số phòng
│   ├── Phòng đang thuê / Phòng trống
│   ├── Tỷ lệ lấp đầy
│   └── Doanh thu tháng này
├── Biểu đồ
│   ├── Doanh thu theo tháng (Line chart)
│   ├── Tỷ lệ phòng trống/thuê (Pie chart)
│   └── Công nợ (Bar chart)
└── Cảnh báo
    ├── Hóa đơn quá hạn
    ├── Hợp đồng sắp hết hạn
    └── Phòng sắp trống

Báo cáo BĐS:
├── Căn hộ trống
├── Căn hộ sắp trống
├── Hợp đồng sắp hết hạn
├── Tỷ lệ lấp đầy
└── Lịch sử thay đổi giá

Báo cáo tài chính:
├── Doanh thu
├── Chi phí
├── Lợi nhuận
├── Công nợ
└── Dòng tiền
```

---

## 🗄️ CẤU TRÚC DỮ LIỆU

### Sơ đồ quan hệ tổng quan

```
┌─────────────┐
│    users    │ (Supabase Auth)
└──────┬──────┘
       │
       ├─────────┬─────────┬─────────┐
       │         │         │         │
       ▼         ▼         ▼         ▼
┌──────────┐ ┌──────┐ ┌──────┐ ┌──────┐
│buildings │ │tenants│ │invoices│ │payments│
└────┬─────┘ └───┬──┘ └───┬────┘ └────┬───┘
     │           │        │            │
     ▼           │        │            │
┌──────────┐    │        │            │
│  rooms   │    │        │            │
└────┬─────┘    │        │            │
     │          │        │            │
     ├──────────┼────────┘            │
     │          │                     │
     ▼          ▼                     │
┌──────────┐ ┌──────────┐            │
│  beds    │ │contracts │◄───────────┘
└──────────┘ └────┬─────┘
                  │
                  ▼
          ┌──────────────┐
          │ contract_    │
          │ services     │
          └──────────────┘

┌──────────────┐
│   services   │ (Global)
└──────────────┘

┌──────────────┐
│meter_readings│
└──────────────┘
```

### Chi tiết các bảng (xem docs/01-DATABASE-SCHEMA.md)

---

## 🔄 FLOW TỔNG QUAN

### 1. Flow khởi động hệ thống (Initial Setup)

```
Đăng ký → Đăng nhập → Dashboard
                         │
                         ├─→ Tạo Tòa nhà
                         │      │
                         │      ├─→ Tạo Phòng
                         │      │      │
                         │      │      └─→ Tạo Giường (nếu KTX)
                         │      │
                         │      └─→ Import hàng loạt
                         │
                         └─→ Cấu hình Dịch vụ
                                │
                                └─→ Sẵn sàng cho thuê
```

### 2. Flow vận hành hàng tháng

```
┌─────────────────────────────────────────────────────────────┐
│                    ĐẦU THÁNG                                 │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌────────────────────┐
              │  Ghi chỉ số        │
              │  (Điện, nước)      │
              └─────────┬──────────┘
                        │
                        ▼
              ┌────────────────────┐
              │  Lập hóa đơn       │
              │  (Auto/Manual)     │
              └─────────┬──────────┘
                        │
                        ▼
              ┌────────────────────┐
              │  Duyệt hóa đơn     │
              │  + Gửi thông báo   │
              └─────────┬──────────┘
                        │
┌─────────────────────────────────────────────────────────────┐
│                   TRONG THÁNG                                │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
              ┌────────────────────┐
              │  Khách thanh toán  │
              │  Thu tiền          │
              └─────────┬──────────┘
                        │
                        ├─→ Đã thanh toán → Cập nhật sổ quỹ
                        │
                        └─→ Chưa thanh toán → Nhắc nợ
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────┐
│                   CUỐI THÁNG                                 │
└─────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                                      ┌────────────────────┐
                                      │  Báo cáo tháng     │
                                      │  - Doanh thu       │
                                      │  - Công nợ         │
                                      │  - Lợi nhuận       │
                                      └────────────────────┘
```

### 3. Flow quản lý hợp đồng

```
Khách hẹn xem phòng
        │
        ▼
Khách đặt cọc giữ chỗ
        │
        ▼
Ký hợp đồng (Check-in)
        │
        ├─→ Nhập thông tin khách
        ├─→ Chọn phòng/giường
        ├─→ Cấu hình tài chính
        └─→ Chốt chỉ số đầu (điện, nước)
        │
        ▼
┌────────────────────────────────────┐
│      TRONG QUÁ TRÌNH THUÊ          │
│                                    │
│  ├─→ Gia hạn hợp đồng             │
│  ├─→ Chuyển phòng                 │
│  ├─→ Nhượng hợp đồng              │
│  └─→ Báo cáo sự cố                │
└────────────────────────────────────┘
        │
        ▼
Thanh lý hợp đồng (Check-out)
        │
        ├─→ Tính toán công nợ
        ├─→ Tính tiền phòng còn lại
        ├─→ Hoàn trả cọc
        └─→ Thu/Trả số tiền cuối cùng
```

---

## 🗺️ ROADMAP TRIỂN KHAI

### PHASE 1: Foundation (Tuần 1-2)
```
✅ Setup project structure
✅ Configure Supabase
□ Design database schema
□ Implement authentication
   ├── Register
   ├── Login
   └── Forgot password (basic)
□ Setup routing
□ Create main layout
   ├── Header
   ├── Sidebar
   └── Dashboard shell
```

### PHASE 2: Asset Management (Tuần 3-4)
```
□ Implement Building management
   ├── Create building
   ├── List buildings
   ├── Edit building
   └── Delete building
□ Implement Room management
   ├── Create room
   ├── List rooms
   ├── Edit room
   └── Delete room
□ Implement Bed management (for dorm model)
□ Implement Service management
□ Building map visualization
```

### PHASE 3: Leasing Management (Tuần 5-6)
```
□ Implement Tenant management
□ Implement Contract management
   ├── Create contract (check-in)
   ├── Contract details
   ├── Extend contract
   ├── Transfer room
   ├── Transfer contract
   └── Terminate contract (check-out)
□ Calculate deposit & rent
□ Contract templates
```

### PHASE 4: Billing & Finance (Tuần 7-8)
```
□ Implement Meter reading
   ├── Record electricity
   └── Record water
□ Implement Invoice management
   ├── Auto-generate invoices
   ├── Manual create invoice
   ├── Approve invoice
   ├── Bulk approve
   └── Invoice details
□ Implement Payment collection
   ├── Record payment
   ├── Partial payment
   └── Cash book
□ Print invoice (PDF/thermal)
```

### PHASE 5: Reports & Analytics (Tuần 9-10)
```
□ Dashboard
   ├── Overview statistics
   ├── Revenue chart
   ├── Occupancy chart
   └── Alerts
□ Asset reports
   ├── Vacant rooms
   ├── Occupancy rate
   └── Expiring contracts
□ Financial reports
   ├── Revenue report
   ├── Debt report
   ├── Cash flow
   └── Profit allocation
```

### PHASE 6: Advanced Features (Tuần 11-12)
```
□ Import/Export Excel
   ├── Import buildings
   ├── Import rooms
   ├── Export reports
   └── Template download
□ Bulk actions
   ├── Bulk approve invoices
   ├── Bulk create invoices
   └── Bulk update
□ Notifications
   ├── Email notifications
   ├── In-app notifications
   └── Push notifications (future)
□ Settings & Configuration
   ├── System settings
   ├── Template management
   └── User preferences
```

### PHASE 7: Integration & Optimization (Tuần 13-14)
```
□ SMS/Zalo integration (future)
□ Payment gateway (future)
□ IoT integration (future)
□ Performance optimization
□ Security hardening
□ Testing & bug fixes
□ Documentation
□ Deployment
```

---

## 📚 TÀI LIỆU THAM KHẢO

### Tài liệu chi tiết
1. **[01-DATABASE-SCHEMA.md](./01-DATABASE-SCHEMA.md)** - Database schema đầy đủ cho Supabase
2. **[02-AUTH-FLOW.md](./02-AUTH-FLOW.md)** - Hướng dẫn implement authentication
3. **[03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md)** - Quản lý tòa nhà, phòng, giường
4. **[04-SERVICE-MANAGEMENT.md](./04-SERVICE-MANAGEMENT.md)** - Quản lý dịch vụ
5. **[05-LEASING-FLOW.md](./05-LEASING-FLOW.md)** - Quản lý hợp đồng và khách thuê
6. **[06-BILLING-FLOW.md](./06-BILLING-FLOW.md)** - Quản lý hóa đơn và tài chính
7. **[07-COMPONENT-STRUCTURE.md](./07-COMPONENT-STRUCTURE.md)** - Cấu trúc component và UI
8. **[08-API-INTEGRATION.md](./08-API-INTEGRATION.md)** - Tích hợp Supabase API
9. **[09-IMPLEMENTATION-GUIDE.md](./09-IMPLEMENTATION-GUIDE.md)** - Hướng dẫn implementation từng bước

### External References
- Resident Docs: https://docs.resident.vn/
- Supabase Docs: https://supabase.com/docs
- React Router: https://reactrouter.com/
- TanStack Query: https://tanstack.com/query/
- shadcn/ui: https://ui.shadcn.com/
- Tailwind CSS: https://tailwindcss.com/

---

## 🎯 LƯU Ý QUAN TRỌNG

### Business Logic
1. **Phân cấp tài sản**: Building → Room → Bed (Bed là optional, chỉ dùng cho KTX/Sleepbox)
2. **Chu kỳ thanh toán**: Hỗ trợ nhiều chu kỳ (1 tháng, 3 tháng, 6 tháng, 1 năm)
3. **Tính tiền cọc**: Tổng cọc = Tiền cọc - Tiền đã cọc giữ chỗ
4. **Hóa đơn**: Hạn thanh toán = Ngày lập + 5 ngày (configurable)
5. **Thanh lý**: Phải tính toán chính xác công nợ, tiền phòng, hoàn cọc

### Technical Decisions
1. **State Management**: TanStack Query cho server state, React Context cho UI state
2. **Form Validation**: Zod + React Hook Form
3. **Styling**: Tailwind CSS + shadcn/ui components
4. **Authentication**: Supabase Auth + RLS
5. **Real-time**: Supabase Realtime subscriptions cho notifications

### Security
1. **Row Level Security (RLS)**: Bắt buộc cho tất cả tables
2. **Input Validation**: Validate ở cả client và server
3. **API Security**: Sử dụng Supabase RLS policies
4. **File Upload**: Validate file type, size trước khi upload

### Performance
1. **Pagination**: Áp dụng cho tất cả danh sách lớn
2. **Lazy Loading**: Load components khi cần
3. **Image Optimization**: Compress và resize images
4. **Caching**: TanStack Query auto caching

---

**Tác giả**: AI Agent
**Ngày tạo**: 2025-11-18
**Version**: 1.0.0
**Next**: [01-DATABASE-SCHEMA.md](./01-DATABASE-SCHEMA.md)
