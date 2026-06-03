# PHÂN TÍCH CÁC TÍNH NĂNG CÒN THIẾU
## So sánh docs.resident.vn vs Tài liệu hiện tại

---

## 📊 TỔNG HỢP THÔNG TIN ĐÃ ĐỌC

### Nguồn: docs.resident.vn

Đã đọc toàn bộ các trang:
- ✅ Giới thiệu & Đăng ký/Đăng nhập
- ✅ Hướng dẫn khởi tạo dữ liệu
- ✅ Theo dõi nhanh (Bảng tin, Sơ đồ tòa nhà)
- ✅ Danh mục dữ liệu (Tòa nhà, Căn hộ, Giường, Dịch vụ, Tài sản)
- ✅ Khách hàng (Khách hẹn, Đặt cọc, Hợp đồng, Thông tin khách, Phương tiện)
- ✅ Tài chính (Ghi chỉ số, Hóa đơn, Thu chi)
- ✅ Gửi thông báo
- ✅ Sự cố/Công việc
- ✅ Báo cáo (BĐS, Tài chính, Công việc)
- ✅ Cài đặt hệ thống (Chung, Mẫu biểu, Nhân viên, Danh mục khác)
- ✅ Thông tin khác (Mã code, FAQ, Lịch sử cập nhật)

---

## 🔍 PHÂN TÍCH SO SÁNH

### ✅ ĐÃ CÓ TRONG DOCS HIỆN TẠI

1. **00-OVERVIEW.md** - Tổng quan hệ thống ✓
2. **01-DATABASE-SCHEMA.md** - Database schema ✓
3. **02-AUTH-FLOW.md** - Authentication ✓
4. **03-ASSET-MANAGEMENT.md** - Buildings, Rooms, Beds, Services ✓
5. **05-LEASING-FLOW.md** - Contracts (cơ bản) ✓
6. **06-BILLING-FLOW.md** - Invoices, Payments (cơ bản) ✓

### ❌ THIẾU HOÀN TOÀN (Cần tạo mới)

#### 1. **LEAD & DEPOSIT MANAGEMENT** (Khách hẹn & Đặt cọc)
```
Quy trình: Prospect → Appointment → Deposit → Contract

Khách hẹn (Lead Management):
├─ B1: Bắn khách (Lead Generation)
│  └─ Nguồn: Website, Facebook, Zalo, Điện thoại, Giới thiệu
├─ B2: Hẹn khách (Schedule Appointment)
│  ├─ Chọn tòa nhà, phòng
│  ├─ Thời gian hẹn xem
│  ├─ Phân công nhân viên
│  └─ Ghi chú
├─ B3: Tư vấn bán hàng (Sales Consultation)
│  ├─ Khách xem phòng
│  ├─ Tư vấn giá, dịch vụ
│  └─ Thương lượng
└─ B4: Chuyển đổi
   ├─ → Đặt cọc (nếu đồng ý)
   ├─ → Thất bại (mark as failed)
   └─ → Tiếp tục theo dõi

Đặt cọc (Deposit Management):
├─ Thông tin:
│  ├─ Khách hàng
│  ├─ Phòng/Giường đặt cọc
│  ├─ Số tiền cọc
│  ├─ Ngày cọc
│  └─ Giữ phòng đến ngày (hold_until)
├─ Trạng thái:
│  ├─ PENDING (Chờ xác nhận)
│  ├─ CONFIRMED (Đã xác nhận)
│  ├─ CONVERTED (Đã chuyển thành HĐ)
│  ├─ REFUNDED (Đã hoàn cọc)
│  └─ FORFEITED (Bị mất cọc)
└─ Hành động:
   ├─ Xác nhận đặt cọc
   ├─ Ký hợp đồng (convert to contract)
   ├─ Hủy cọc (cancel + refund/forfeit)
   └─ In phiếu thu tiền cọc
```

**Database Tables cần thêm:**
```sql
-- Leads (Khách hẹn)
CREATE TABLE leads (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  source TEXT, -- Facebook, Zalo, Phone, Referral, Walk-in

  -- Appointment
  building_id UUID REFERENCES buildings,
  room_id UUID REFERENCES rooms,
  appointment_date TIMESTAMPTZ,
  assigned_staff_id UUID REFERENCES profiles,

  -- Status workflow
  status TEXT, -- B1_LEAD, B2_APPOINTMENT, B3_CONSULTATION, CONVERTED, FAILED

  -- Notes
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deposits table đã có trong 01-DATABASE-SCHEMA.md
-- Chỉ cần bổ sung thêm fields:
ALTER TABLE deposits ADD COLUMN lead_id UUID REFERENCES leads;
ALTER TABLE deposits ADD COLUMN source TEXT; -- From lead or direct
```

---

#### 2. **VEHICLE MANAGEMENT** (Quản lý phương tiện)
```
Quản lý xe của khách thuê

Thông tin phương tiện:
├─ Loại xe (Xe máy, Ô tô, Xe đạp)
├─ Tên dòng xe (Honda Wave, Toyota Vios...)
├─ Biển số xe (29A-12345)
├─ Màu xe
├─ Chủ xe (Tenant)
├─ Hợp đồng liên kết
└─ Phí gửi xe (nếu có)

Tính năng:
├─ CRUD phương tiện
├─ Import hàng loạt từ Excel
├─ Liên kết với hợp đồng
├─ Tính phí gửi xe vào hóa đơn
└─ Báo cáo: Danh sách xe theo tòa nhà
```

**Database Table:**
```sql
CREATE TYPE vehicle_type AS ENUM ('MOTORBIKE', 'CAR', 'BICYCLE', 'OTHER');

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  contract_id UUID REFERENCES contracts(id),

  -- Vehicle info
  vehicle_type vehicle_type NOT NULL,
  brand TEXT, -- Honda, Toyota...
  model TEXT, -- Wave, Vios...
  license_plate TEXT, -- Biển số
  color TEXT,

  -- Parking fee
  parking_fee DECIMAL(15, 2) DEFAULT 0,

  -- Metadata
  notes TEXT,
  images JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

---

#### 3. **ASSET/INVENTORY MANAGEMENT** (Quản lý tài sản/Nội thất)
```
Quản lý nội thất, thiết bị trong phòng

Cấu trúc:
├─ Danh mục tài sản (Asset Categories)
│  ├─ Loại tài sản (Giường, Tủ lạnh, Máy lạnh, Bàn ghế...)
│  ├─ Nhà cung cấp (Suppliers)
│  └─ Kho tài sản (Warehouses)
│
├─ Tài sản (Assets/Inventory Items)
│  ├─ Mã tài sản
│  ├─ Tên tài sản
│  ├─ Loại tài sản
│  ├─ Số lượng
│  ├─ Giá trị
│  ├─ Tình trạng (Tốt, Cũ, Hư hỏng)
│  ├─ Vị trí (Building, Room)
│  └─ Ngày mua
│
├─ Bàn giao tài sản (Asset Handover)
│  ├─ Khi ký HĐ: Bàn giao cho khách
│  ├─ Khi thanh lý: Thu hồi tài sản
│  └─ Kiểm tra tình trạng
│
├─ Lịch sử di chuyển (Asset Movement)
│  ├─ Từ phòng → phòng
│  ├─ Từ kho → phòng
│  └─ Từ phòng → kho
│
└─ Sửa chữa/Bảo trì (Maintenance)
   ├─ Báo cáo hư hỏng
   ├─ Chi phí sửa chữa
   └─ Lịch sử sửa chữa
```

**Database Tables:**
```sql
CREATE TYPE asset_condition AS ENUM ('NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN');

-- Asset Categories
CREATE TABLE asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Suppliers
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Assets
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Asset info
  code TEXT, -- Mã tài sản
  name TEXT NOT NULL,
  category_id UUID REFERENCES asset_categories(id),

  -- Purchase info
  supplier_id UUID REFERENCES suppliers(id),
  purchase_date DATE,
  purchase_price DECIMAL(15, 2),

  -- Current status
  condition asset_condition DEFAULT 'GOOD',
  quantity INTEGER DEFAULT 1,

  -- Location
  building_id UUID REFERENCES buildings(id),
  room_id UUID REFERENCES rooms(id),

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Asset Handovers (Biên bản bàn giao)
CREATE TABLE asset_handovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  contract_id UUID NOT NULL REFERENCES contracts(id),

  -- Type
  type TEXT, -- CHECK_IN, CHECK_OUT
  handover_date DATE NOT NULL,

  -- Items (JSONB array)
  -- [{ asset_id, quantity, condition, notes }, ...]
  items JSONB NOT NULL,

  -- Signatures
  landlord_signature TEXT, -- Image URL
  tenant_signature TEXT, -- Image URL

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Asset Movements
CREATE TABLE asset_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  asset_id UUID NOT NULL REFERENCES assets(id),

  -- Movement
  from_location TEXT, -- warehouse/room
  to_location TEXT,
  from_room_id UUID REFERENCES rooms(id),
  to_room_id UUID REFERENCES rooms(id),

  quantity INTEGER NOT NULL,
  movement_date DATE NOT NULL,
  reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Asset Maintenance
CREATE TABLE asset_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  asset_id UUID NOT NULL REFERENCES assets(id),

  -- Maintenance info
  issue_description TEXT NOT NULL,
  maintenance_date DATE NOT NULL,
  cost DECIMAL(15, 2),

  -- Assigned
  assigned_to UUID REFERENCES profiles(id),

  status TEXT, -- PENDING, IN_PROGRESS, COMPLETED

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

#### 4. **ISSUES & TASKS MANAGEMENT** (Sự cố & Công việc)
```
Quản lý sự cố và phân công công việc

Quy trình:
├─ 1. Báo cáo sự cố
│  ├─ Nguồn: Khách thuê báo (qua app) hoặc Chủ nhà tạo
│  ├─ Thông tin:
│  │  ├─ Loại sự cố (Điện, Nước, Wifi, Nội thất, Khác...)
│  │  ├─ Mô tả chi tiết
│  │  ├─ Mức độ ưu tiên (Thấp, Trung bình, Cao, Khẩn cấp)
│  │  ├─ Phòng/Tòa nhà
│  │  ├─ Ảnh chụp
│  │  └─ Người báo cáo
│  └─ Tạo ticket
│
├─ 2. Tiếp nhận & Phân công
│  ├─ Chủ nhà/Quản lý xem ticket
│  ├─ Phân công nhân viên xử lý
│  ├─ Ước tính thời gian xử lý
│  └─ Cập nhật trạng thái: ASSIGNED
│
├─ 3. Xử lý
│  ├─ Nhân viên nhận task
│  ├─ Cập nhật tiến độ
│  ├─ Ghi chú quá trình xử lý
│  ├─ Upload ảnh (nếu có)
│  └─ Trạng thái: IN_PROGRESS
│
└─ 4. Hoàn thành & Đánh giá
   ├─ Nhân viên đánh dấu hoàn thành
   ├─ Ghi chú kết quả
   ├─ Chi phí phát sinh (nếu có)
   ├─ Khách thuê xác nhận (qua app)
   ├─ Đánh giá chất lượng
   └─ Trạng thái: COMPLETED / CLOSED

Báo cáo:
├─ Tổng quan công việc
├─ Công việc theo nhân viên
├─ Công việc theo căn hộ
├─ Thống kê theo loại sự cố
└─ Thời gian xử lý trung bình
```

**Database Tables:**
```sql
CREATE TYPE issue_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE issue_status AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- Issue Categories
CREATE TABLE issue_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL, -- Điện, Nước, Wifi, Nội thất...
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Issues/Tasks
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Issue info
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id UUID REFERENCES issue_categories(id),
  priority issue_priority DEFAULT 'MEDIUM',
  status issue_status DEFAULT 'NEW',

  -- Location
  building_id UUID REFERENCES buildings(id),
  room_id UUID REFERENCES rooms(id),
  contract_id UUID REFERENCES contracts(id),

  -- Reporter
  reported_by_tenant_id UUID REFERENCES tenants(id),
  reported_by_staff_id UUID REFERENCES profiles(id),

  -- Assignment
  assigned_to UUID REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ,

  -- Timeline
  due_date TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  -- Cost
  estimated_cost DECIMAL(15, 2),
  actual_cost DECIMAL(15, 2),

  -- Metadata
  images JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,

  -- Rating (from tenant)
  rating INTEGER, -- 1-5
  feedback TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Issue Comments/Updates
CREATE TABLE issue_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),

  comment TEXT NOT NULL,
  images JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

#### 5. **NOTIFICATION SYSTEM** (Gửi thông báo)
```
Hệ thống gửi thông báo đa kênh

Kênh gửi:
├─ In-app notification (Thông báo trong app)
├─ Email
├─ SMS Brandname
├─ Zalo ZNS (Zalo Notification Service)
└─ Push notification (Mobile app)

Loại thông báo:
├─ Hóa đơn mới (New invoice)
├─ Nhắc thanh toán (Payment reminder)
├─ Hóa đơn quá hạn (Overdue invoice)
├─ Hợp đồng sắp hết hạn (Contract expiring)
├─ Sự cố được xử lý (Issue resolved)
├─ Thông báo chung (General announcement)
└─ Custom message

Tính năng:
├─ Tạo thông báo mới
│  ├─ Chọn loại thông báo
│  ├─ Chọn người nhận (Single/Multiple/All)
│  ├─ Nội dung (Template hoặc Custom)
│  ├─ Chọn kênh gửi
│  └─ Lên lịch gửi (Ngay lập tức hoặc Hẹn giờ)
│
├─ Template thông báo
│  ├─ Mẫu sẵn cho từng loại
│  ├─ Variables: {tenant_name}, {amount}, {due_date}...
│  └─ Customize templates
│
├─ Lịch sử gửi
│  ├─ Theo dõi trạng thái gửi
│  ├─ Success/Failed
│  └─ Delivery report
│
└─ Tự động hóa
   ├─ Auto gửi khi duyệt hóa đơn
   ├─ Auto nhắc nợ trước hạn 3 ngày
   ├─ Auto nhắc HĐ hết hạn trước 30 ngày
   └─ Cron jobs
```

**Database Tables:**
```sql
CREATE TYPE notification_type AS ENUM (
  'NEW_INVOICE',
  'PAYMENT_REMINDER',
  'OVERDUE_INVOICE',
  'CONTRACT_EXPIRING',
  'ISSUE_RESOLVED',
  'GENERAL_ANNOUNCEMENT',
  'CUSTOM'
);

CREATE TYPE notification_channel AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'ZALO', 'PUSH');
CREATE TYPE notification_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- Notification Templates
CREATE TABLE notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  type notification_type NOT NULL,
  name TEXT NOT NULL,

  -- Content for each channel
  email_subject TEXT,
  email_body TEXT,
  sms_content TEXT,
  zalo_template_id TEXT,
  push_title TEXT,
  push_body TEXT,

  -- Variables: {tenant_name}, {amount}, {due_date}, etc.

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notifications
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  type notification_type NOT NULL,
  channel notification_channel NOT NULL,

  -- Recipients
  recipient_tenant_ids UUID[], -- Array of tenant IDs
  recipient_emails TEXT[],
  recipient_phones TEXT[],

  -- Content
  subject TEXT,
  content TEXT NOT NULL,

  -- Related entities
  invoice_id UUID REFERENCES invoices(id),
  contract_id UUID REFERENCES contracts(id),
  issue_id UUID REFERENCES issues(id),

  -- Scheduling
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- Status
  status notification_status DEFAULT 'PENDING',
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notification Logs (Delivery status for each recipient)
CREATE TABLE notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),

  recipient_id UUID, -- tenant_id or staff_id
  recipient_email TEXT,
  recipient_phone TEXT,

  channel notification_channel NOT NULL,
  status notification_status NOT NULL,

  sent_at TIMESTAMPTZ,
  error_message TEXT,

  -- Provider response (Zalo, SMS gateway)
  provider_response JSONB
);
```

---

#### 6. **DASHBOARD & ANALYTICS** (Bảng tin & Thống kê)
```
Dashboard tổng quan với Real-time statistics

Layout:
┌────────────────────────────────────────────────────────────┐
│                     OVERVIEW CARDS                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │  Total  │  │  Rooms  │  │ Revenue │  │  Debts  │       │
│  │ Rooms   │  │Occupied │  │  Month  │  │  Total  │       │
│  │   120   │  │   95    │  │  150M   │  │   20M   │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│                       CHARTS                                │
│  ┌─────────────────────────┐  ┌──────────────────────┐     │
│  │  Revenue Line Chart     │  │  Occupancy Pie Chart │     │
│  │  (Last 12 months)       │  │  Vacant: 25          │     │
│  │                         │  │  Occupied: 95        │     │
│  └─────────────────────────┘  └──────────────────────┘     │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│                       ALERTS                                │
│  🔴 5 invoices overdue                                      │
│  🟡 10 contracts expiring in 30 days                        │
│  🟢 3 new deposits today                                    │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│                   RECENT ACTIVITIES                         │
│  • Nguyễn Văn A paid invoice #INV-001 - 2.5M               │
│  • New contract signed for Room 201                         │
│  • Issue #ISS-123 resolved                                  │
└────────────────────────────────────────────────────────────┘

Thống kê hiển thị:
├─ Tổng số phòng/giường
├─ Phòng đang thuê / Phòng trống
├─ Tỷ lệ lấp đầy (%)
├─ Doanh thu tháng này
├─ Công nợ tổng
├─ Hóa đơn chưa thanh toán
├─ Hợp đồng sắp hết hạn
├─ Sự cố đang xử lý
└─ Khách hẹn chưa chuyển đổi

Biểu đồ:
├─ Doanh thu theo tháng (Line chart)
├─ Tỷ lệ phòng trống/thuê (Pie chart)
├─ Công nợ theo tháng (Bar chart)
├─ Top 5 khách nợ nhiều nhất
└─ Sự cố theo loại

Cảnh báo (Alerts):
├─ Hóa đơn quá hạn
├─ Hợp đồng sắp hết hạn (30, 15, 7 ngày)
├─ Phòng sắp trống
├─ Sự cố chưa xử lý quá 24h
└─ Công nợ vượt ngưỡng

Real-time updates:
└─ Sử dụng Supabase Realtime subscriptions
```

---

#### 7. **BUILDING MAP VISUALIZATION** (Sơ đồ tòa nhà)
```
Sơ đồ trực quan với color coding

View modes:
├─ Grid view (Lưới)
│  └─ Hiển thị phòng theo tầng, dạng ô vuông
│
└─ Floor plan view (Sơ đồ mặt bằng)
   └─ Upload hình sơ đồ, click vào phòng

Color coding (Mã màu trạng thái):
├─ 🟢 Green - Đang cho thuê (OCCUPIED)
├─ 🟠 Orange - Đã đặt cọc (RESERVED)
├─ 🔴 Red - Phòng trống (AVAILABLE)
├─ 🟣 Purple - Sắp trống (EXPIRING_SOON)
└─ ⚫ Gray - Ngừng hoạt động (INACTIVE/MAINTENANCE)

Click vào phòng hiển thị popup:
├─ Thông tin phòng (Tên, diện tích, giá)
├─ Hợp đồng hiện tại (nếu có)
├─ Thông tin khách thuê
├─ Hóa đơn gần nhất
├─ Tài sản trong phòng
├─ Ảnh phòng
└─ Actions: Tạo HĐ, Xem chi tiết, Báo cáo sự cố

Filters:
├─ Lọc theo tòa nhà
├─ Lọc theo tầng
├─ Lọc theo trạng thái
└─ Tìm kiếm phòng

Export:
└─ Export sơ đồ ra PNG/PDF
```

---

#### 8. **REPORTS SYSTEM** (Hệ thống báo cáo)
```
Báo cáo chi tiết với export Excel/PDF

A. BÁO CÁO BẤT ĐỘNG SẢN:

1. Căn hộ trống
   ├─ Danh sách phòng trống
   ├─ Thời gian trống
   ├─ Giá thuê
   └─ Số ngày trống

2. Căn hộ sắp trống
   ├─ HĐ sắp hết hạn (<30 ngày)
   ├─ Ngày kết thúc HĐ
   ├─ Khách thuê
   └─ Trạng thái gia hạn

3. Phòng gia hạn, chuyển nhượng
   ├─ Danh sách HĐ gia hạn
   ├─ HĐ chuyển nhượng
   └─ Lịch sử thay đổi

4. Tỷ lệ lấp đầy
   ├─ Theo tòa nhà
   ├─ Theo tháng
   ├─ Trend chart
   └─ So sánh với kỳ trước

5. Báo cáo khuyến mại
   ├─ HĐ có giảm giá
   ├─ Tổng giảm giá
   └─ Hiệu quả khuyến mại

6. Báo cáo cho thuê
   ├─ HĐ mới trong kỳ
   ├─ Doanh thu mới
   └─ Conversion rate từ lead

7. Báo cáo bỏ trả
   ├─ HĐ thanh lý trong kỳ
   ├─ Lý do chấm dứt
   ├─ Tỷ lệ bỏ trả
   └─ Phân tích nguyên nhân

B. BÁO CÁO TÀI CHÍNH:

1. Sổ quỹ theo ngày
   ├─ Thu chi hàng ngày
   ├─ Số dư đầu kỳ
   ├─ Tổng thu
   ├─ Tổng chi
   └─ Số dư cuối kỳ

2. Dòng tiền (Cash Flow)
   ├─ Operating cash flow
   ├─ Investing cash flow
   ├─ Financing cash flow
   └─ Net cash flow

3. Phân bổ lợi nhuận
   ├─ Doanh thu
   ├─ Chi phí
   ├─ Lợi nhuận
   └─ Margin %

4. Công nợ hợp đồng mới
   ├─ HĐ có công nợ
   ├─ Số tiền nợ
   ├─ Số ngày quá hạn
   └─ Aging analysis

5. Khách nợ tiền
   ├─ Top debtors
   ├─ Tổng công nợ
   ├─ Phân loại theo mức độ
   └─ Hành động cần làm

6. Lịch thanh toán
   ├─ HĐ cần thu trong tháng
   ├─ Ngày đáo hạn
   ├─ Số tiền
   └─ Calendar view

7. Tiền thừa
   ├─ Khách trả thừa
   ├─ Cần hoàn lại
   └─ Credits

8. Danh sách tiền cọc
   ├─ Tổng tiền cọc đang giữ
   ├─ Phân theo trạng thái
   └─ Cần hoàn trả

C. BÁO CÁO CÔNG VIỆC:

1. Tổng quan công việc
   ├─ Tổng số task
   ├─ Hoàn thành
   ├─ Đang xử lý
   └─ Quá hạn

2. Công việc theo nhân viên
   ├─ Assigned tasks
   ├─ Performance
   ├─ Completion rate
   └─ Avg resolution time

3. Công việc theo căn hộ
   ├─ Sự cố theo phòng
   ├─ Tần suất
   ├─ Chi phí sửa chữa
   └─ Phòng có vấn đề nhiều nhất

Export formats:
├─ Excel (.xlsx)
├─ PDF
└─ CSV
```

---

#### 9. **SETTINGS & CONFIGURATION** (Cài đặt hệ thống)
```
Cấu hình chi tiết hệ thống

A. CÀI ĐẶT CHUNG:

1. Thông tin doanh nghiệp
   ├─ Logo
   ├─ Tên công ty
   ├─ Địa chỉ
   ├─ SĐT, Email
   └─ Mã số thuế

2. Cấu hình hợp đồng
   ├─ Tự động gán số người theo HĐ
   ├─ Bàn giao tài sản khi ký/thanh lý
   ├─ Tự động tạo HĐ gia hạn
   ├─ Ký HĐ online
   ├─ Cố định ngày thanh toán
   ├─ Hiển thị trạng thái HĐ hết hạn
   └─ Thông báo HĐ sắp hết hạn

3. Cấu hình hóa đơn
   ├─ Tự động duyệt chỉ số & hóa đơn
   ├─ Hệ số tính toán
   ├─ Chu kỳ dịch vụ
   ├─ Tính toán theo tỷ lệ (nếu < 1 tháng)
   ├─ Số ngày hạn thanh toán (default: 5)
   ├─ Tự động tạo hóa đơn tiền cọc
   ├─ Tự động tạo hóa đơn kỳ sau
   └─ Cho phép khách ghi chỉ số trên app

4. Thanh toán & Thông báo
   ├─ Tự động duyệt thanh toán
   ├─ Nhắc hạn thanh toán
   ├─ Tích hợp Zalo OA
   ├─ Cấu hình SMS Brandname
   └─ Cấu hình Email SMTP

B. MẪU BIỂU:

1. Mẫu hợp đồng
   ├─ Upload template Word/PDF
   ├─ Variables: {tenant_name}, {room_name}, {rent_price}...
   ├─ Multiple templates
   └─ Default template

2. Mẫu phiếu thu chi
   ├─ Phiếu thu tiền
   ├─ Phiếu chi
   ├─ Logo, thông tin công ty
   └─ Custom fields

3. Mẫu hóa đơn
   ├─ Invoice template
   ├─ Thermal printer format (80mm, 58mm)
   ├─ A4 format
   └─ Custom branding

C. NHÂN VIÊN & PHÂN QUYỀN:

1. Quản lý nhân viên
   ├─ Thêm nhân viên
   ├─ Thông tin cá nhân
   ├─ Vai trò (Role)
   └─ Trạng thái (Active/Inactive)

2. Phân quyền (Permissions)
   ├─ Role-based access control
   ├─ Permissions theo module:
   │  ├─ Buildings: View, Create, Edit, Delete
   │  ├─ Contracts: View, Create, Edit, Approve, Terminate
   │  ├─ Invoices: View, Create, Edit, Approve, Collect
   │  ├─ Reports: View, Export
   │  └─ Settings: View, Edit
   └─ Gán quyền theo tòa nhà (Staff chỉ quản lý tòa được gán)

D. DANH MỤC KHÁC:

1. Tài chính
   ├─ Tài khoản ngân hàng
   ├─ Tự động ghi nhận công nợ
   ├─ Hóa đơn điện tử
   ├─ Loại giao dịch
   ├─ Tiêu chuẩn dịch vụ
   └─ Quản lý công tơ

2. Tài sản
   ├─ Nhà cung cấp
   ├─ Kho tài sản
   ├─ Loại tài sản
   └─ Lịch sử di chuyển/sửa chữa

3. Hotline & Communication
   ├─ Quản lý Hotline
   ├─ Zalo OA integration
   └─ SMS gateway

4. Công việc
   ├─ Loại công việc (categories)
   └─ Workflow

5. Danh mục chung
   ├─ Danh sách tầng (Floors)
   └─ Custom fields
```

---

#### 10. **CODE GENERATION SYSTEM** (Hệ thống mã code)
```
Tự động tạo mã cho các đối tượng

Đối tượng cần mã:
├─ Tòa nhà (Building Code)
├─ Phòng (Room Code)
├─ Hợp đồng (Contract Number)
├─ Hóa đơn (Invoice Number)
├─ Phiếu thu (Receipt Number)
├─ Phiếu chi (Payment Voucher Number)
├─ Khách hàng (Customer Code)
└─ Tài sản (Asset Code)

Format mã:
├─ Prefix (Tiền tố): TOA, PHONG, HD, INV, PT, PC...
├─ Separator: - hoặc /
├─ Date component: YYYY, YYMM, YYMMDD
├─ Sequential number: 001, 0001, 00001
└─ Examples:
   ├─ TOA-2024-001
   ├─ HD/202411/0001
   ├─ INV-2024-00123
   └─ PT-20241118-0045

Cấu hình:
├─ Enable/Disable auto code
├─ Custom format per object type
├─ Reset counter: Daily, Monthly, Yearly, Never
├─ Starting number
└─ Padding length (3, 4, 5 digits)

Implementation:
└─ Database function hoặc application logic
```

**Database table:**
```sql
CREATE TABLE code_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  object_type TEXT NOT NULL, -- building, room, contract, invoice...
  prefix TEXT NOT NULL,
  separator TEXT DEFAULT '-',
  date_format TEXT, -- YYYY, YYMM, YYMMDD, null
  sequence_length INTEGER DEFAULT 4, -- Padding
  current_sequence INTEGER DEFAULT 0,
  reset_period TEXT DEFAULT 'YEARLY', -- DAILY, MONTHLY, YEARLY, NEVER
  last_reset_at DATE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, object_type)
);

-- Function to generate next code
CREATE OR REPLACE FUNCTION generate_code(
  p_user_id UUID,
  p_object_type TEXT
) RETURNS TEXT AS $$
DECLARE
  v_config RECORD;
  v_next_seq INTEGER;
  v_code TEXT;
  v_date_part TEXT;
  v_need_reset BOOLEAN := false;
BEGIN
  -- Get config
  SELECT * INTO v_config
  FROM code_sequences
  WHERE user_id = p_user_id AND object_type = p_object_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Code configuration not found for %', p_object_type;
  END IF;

  -- Check if need reset
  IF v_config.reset_period = 'DAILY' AND
     v_config.last_reset_at < CURRENT_DATE THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'MONTHLY' AND
        DATE_TRUNC('month', v_config.last_reset_at) < DATE_TRUNC('month', CURRENT_DATE) THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'YEARLY' AND
        DATE_TRUNC('year', v_config.last_reset_at) < DATE_TRUNC('year', CURRENT_DATE) THEN
    v_need_reset := true;
  END IF;

  -- Reset or increment
  IF v_need_reset THEN
    v_next_seq := 1;
  ELSE
    v_next_seq := v_config.current_sequence + 1;
  END IF;

  -- Generate date part
  IF v_config.date_format IS NOT NULL THEN
    v_date_part := TO_CHAR(CURRENT_DATE, v_config.date_format);
  END IF;

  -- Build code
  v_code := v_config.prefix;

  IF v_date_part IS NOT NULL THEN
    v_code := v_code || v_config.separator || v_date_part;
  END IF;

  v_code := v_code || v_config.separator ||
            LPAD(v_next_seq::TEXT, v_config.sequence_length, '0');

  -- Update sequence
  UPDATE code_sequences
  SET current_sequence = v_next_seq,
      last_reset_at = CASE WHEN v_need_reset THEN CURRENT_DATE ELSE last_reset_at END,
      updated_at = NOW()
  WHERE user_id = p_user_id AND object_type = p_object_type;

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;
```

---

#### 11. **CT01 FORM** (Tờ khai thay đổi thông tin cư trú)
```
Form đăng ký tạm trú theo quy định của Việt Nam

Thông tin cần khai:
├─ Thông tin cơ quan tiếp nhận
│  ├─ Kính gửi (Công an phường/xã...)
│  └─ Địa chỉ cơ quan
│
├─ Thông tin người khai
│  ├─ Họ và tên (IN HOA)
│  ├─ Ngày sinh (DD/MM/YYYY)
│  ├─ Giới tính
│  ├─ CMND/CCCD
│  ├─ Địa chỉ thường trú
│  └─ Chủ hộ/Quan hệ với chủ hộ
│
├─ Nội dung đề nghị
│  ├─ Loại thay đổi (Đăng ký tạm trú/Gia hạn tạm trú/...)
│  ├─ Địa chỉ nơi tạm trú
│  ├─ Từ ngày - Đến ngày
│  └─ Lý do
│
└─ Thành viên cùng chuyển (nếu có)
   ├─ Họ tên
   ├─ Ngày sinh
   ├─ CMND/CCCD
   └─ Quan hệ

Tính năng:
├─ Auto-fill từ thông tin khách thuê
├─ Lưu draft
├─ In form PDF
├─ Submit online (tích hợp với cơ quan chức năng - future)
└─ Lưu lịch sử
```

**Database table:**
```sql
CREATE TABLE ct01_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  contract_id UUID REFERENCES contracts(id),

  -- Form data (JSONB)
  form_data JSONB NOT NULL,
  /*
  {
    "receiving_office": "Công an phường...",
    "applicant": {
      "full_name": "NGUYEN VAN A",
      "dob": "1990-01-01",
      "gender": "Nam",
      "id_number": "001234567890",
      "permanent_address": "...",
      "relationship": "Chủ hộ"
    },
    "request": {
      "type": "Đăng ký tạm trú",
      "address": "...",
      "from_date": "2024-01-01",
      "to_date": "2024-12-31",
      "reason": "Thuê trọ"
    },
    "family_members": [...]
  }
  */

  -- Status
  status TEXT DEFAULT 'DRAFT', -- DRAFT, SUBMITTED, APPROVED, REJECTED

  -- PDF
  pdf_url TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 📋 TỔNG KẾT CÁC PHẦN CẦN BỔ SUNG

### Ưu tiên cao (Core features):
1. ✅ Lead & Deposit Management
2. ✅ Vehicle Management
3. ✅ Asset/Inventory Management
4. ✅ Issues & Tasks Management
5. ✅ Dashboard & Analytics

### Ưu tiên trung bình:
6. ✅ Notification System
7. ✅ Building Map Visualization
8. ✅ Reports System (chi tiết hơn)
9. ✅ Settings & Configuration

### Ưu tiên thấp (Nice to have):
10. ✅ Code Generation System
11. ✅ CT01 Form

---

## 🎯 ROADMAP CẬP NHẬT

### Phase 1: Core Missing Features (Tuần 1-2)
- Lead Management
- Deposit Management
- Vehicle Management
- Dashboard basic

### Phase 2: Operations (Tuần 3-4)
- Asset/Inventory Management
- Issues & Tasks Management
- Building Map
- Notification basic

### Phase 3: Advanced Features (Tuần 5-6)
- All Reports
- Advanced Dashboard
- Notification templates
- Settings & Templates

### Phase 4: Automation & Polish (Tuần 7-8)
- Code Generation
- CT01 Form
- Automation workflows
- Testing & optimization

---

**Next**: Tạo các file docs chi tiết cho từng phần thiếu
