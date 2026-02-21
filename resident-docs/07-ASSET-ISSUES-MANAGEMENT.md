# ASSET & ISSUES MANAGEMENT
## Quản lý Tài sản, Nội thất, Sự cố & Công việc

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Asset Management - Quản lý Tài sản](#asset-management---quản-lý-tài-sản)
3. [Asset Categories & Suppliers](#asset-categories--suppliers)
4. [Asset Handover & Movement](#asset-handover--movement)
5. [Issues & Tasks Management](#issues--tasks-management)
6. [Issues Workflow & SLA](#issues-workflow--sla)
7. [Database Schema](#database-schema)
8. [Flow Diagrams](#flow-diagrams)
9. [Business Logic & Rules](#business-logic--rules)
10. [Component Structure](#component-structure)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Xây dựng hệ thống quản lý tài sản/nội thất (giường, tủ, máy lạnh, tủ lạnh, v.v.) và quản lý sự cố (điện, nước, wifi, nội thất) hoàn chỉnh với tracking, bàn giao, sửa chữa, và đánh giá.

### Key Features
- **Asset Management**: CRUD tài sản, tracking lịch sử, audit trail
- **Asset Handover**: Bàn giao tài sản khi check-in/check-out với biên bản + chữ ký số
- **Asset Movement**: Di chuyển tài sản giữa các kho/phòng
- **Maintenance**: Lịch sử sửa chữa, bảo trì
- **Issues/Tasks**: Báo cáo → Tiếp nhận → Xử lý → Hoàn thành
- **SLA Tracking**: Theo dõi thời gian xử lý, escalation
- **Rating & Feedback**: Đánh giá từ khách thuê

### Tech Stack
- **Supabase**: Database & RLS & Storage (hình ảnh, biên bản PDF)
- **React Hook Form + Zod**: Forms & validation
- **TanStack Query**: Data fetching
- **Signature Pad**: Chữ ký số cho biên bản
- **html2pdf**: Generate biên bản PDF
- **shadcn/ui**: UI components

---

## 🏠 ASSET MANAGEMENT - QUẢN LY TÀI SẢN

### Asset Categories

```
Danh mục tài sản:
├─ Nội thất (Furniture)
│  ├─ Giường (Bed)
│  ├─ Tủ quần áo (Wardrobe)
│  ├─ Bàn làm việc (Desk)
│  ├─ Ghế (Chair)
│  └─ Sofa
├─ Điện lạnh (Climate Control)
│  ├─ Máy lạnh (AC)
│  ├─ Quạt (Fan)
│  └─ Sưởi (Heater)
├─ Điện tử (Appliances)
│  ├─ Tủ lạnh (Refrigerator)
│  ├─ Bếp điện (Electric stove)
│  ├─ Lò vi sóng (Microwave)
│  ├─ Máy giặt (Washing machine)
│  └─ TV
├─ Vệ sinh (Sanitary)
│  ├─ Bồn cầu (Toilet)
│  ├─ Lavabo (Sink)
│  └─ Vòi sen (Shower head)
└─ Khác (Others)
   ├─ Đèn
   ├─ Thảm
   └─ Rèm cửa
```

### Asset CRUD Flow

```
TẠONEW ASSET:
    │
    ├─→ Chọn danh mục (*)
    │
    ├─→ Form:
    │   ├─ Tên tài sản (*)
    │   ├─ Mã tài sản (*)
    │   ├─ Danh mục (*)
    │   ├─ Nhà cung cấp
    │   ├─ Kho lưu trữ (*)
    │   ├─ Giá mua (*)
    │   ├─ Năm sản xuất
    │   ├─ Tuổi thọ dự kiến (năm)
    │   ├─ Hình ảnh
    │   ├─ Ghi chú
    │   └─ Status: AVAILABLE / IN_USE / DAMAGED / RETIRED
    │
    ├─→ Validate
    │   ├─ Mã tài sản unique
    │   └─ Hình ảnh < 5MB
    │
    ├─→ Save + Upload image (Supabase Storage)
    │
    ├─→ Create audit log entry
    │   └─ "Created by admin on 2025-11-18"
    │
    └─→ Asset created ✓

UPDATE ASSET:
    │
    ├─→ Chọn tài sản
    │
    ├─→ Edit form (tương tự)
    │
    ├─→ Track changes:
    │   ├─ Status change
    │   ├─ Location change
    │   └─ Maintenance date
    │
    └─→ Update + audit log

VIEW ASSET DETAILS:
    │
    ├─→ Hiển thị:
    │   ├─ Tên, Mã, Danh mục
    │   ├─ Ảnh (từ Storage)
    │   ├─ Status hiện tại
    │   ├─ Kho hiện tại
    │   ├─ Phòng hiện tại (nếu IN_USE)
    │   ├─ Giá mua + Tuổi (tính toán)
    │   ├─ Lịch sử di chuyển
    │   ├─ Lịch sử bảo trì
    │   ├─ Lịch sử bàn giao
    │   └─ Audit trail
    │
    └─→ List history entries

DELETE ASSET:
    │
    ├─→ Soft delete (update status: RETIRED)
    │
    ├─→ Create audit log
    │
    └─→ Keep for historical records
```

---

## 🏭 ASSET CATEGORIES & SUPPLIERS

### Asset Suppliers Management

```
QUẢN LÝ NHÀ CUNG CẤP:

POST /api/suppliers {
  name: string (*)
  contact_person: string
  phone: string
  email: string
  address: string
  bank_account?: string
  tax_id?: string
  notes?: string
}

GET /api/suppliers              → List all suppliers
GET /api/suppliers/{id}         → Get supplier details
PUT /api/suppliers/{id}         → Update supplier info
DELETE /api/suppliers/{id}      → Deactivate supplier

RELATIONSHIP: Asset.supplier_id → Suppliers.id
```

### Asset Warehouses

```
QUẢN LÝ KHO TÀI SẢN:

├─ Main Warehouse (Kho chính)
│  ├─ Storage capacity: 1000 items
│  ├─ Location: Ground floor
│  └─ Manager: Admin
│
├─ Building A Warehouse
│  ├─ Storage capacity: 500 items
│  ├─ Location: B1 Building A
│  └─ Manager: Supervisor
│
└─ Building B Warehouse
   ├─ Storage capacity: 300 items
   ├─ Location: B1 Building B
   └─ Manager: Supervisor

Database:
CREATE TABLE warehouses (
  id uuid PRIMARY KEY,
  name VARCHAR(100),
  building_id uuid REFERENCES buildings,
  location TEXT,
  capacity INT,
  manager_id uuid REFERENCES auth.users,
  created_at TIMESTAMP
);
```

---

## 🔄 ASSET HANDOVER & MOVEMENT

### Asset Handover on Check-in

```
BÀNGIAO TÀI SẢN KHI CHECK-IN:

Timeline:
Hợp đồng signed (Lease created)
    │
    ├─→ Manager create Asset Handover
    │   ├─ Chọn phòng (*)
    │   ├─ Chọn tài sản cần giao (*)
    │   ├─ Ngày bàn giao (*)
    │   └─ Ghi chú
    │
    ├─→ Generate Biên bản bàn giao
    │   ├─ Handover form template:
    │   │  ├─ Người giao (Staff)
    │   │  ├─ Người nhận (Tenant)
    │   │  ├─ Danh sách tài sản
    │   │  ├─ Điều kiện tài sản (tốt/hỏng)
    │   │  ├─ Chữ ký người giao
    │   │  └─ Chữ ký người nhận
    │   │
    │   └─ Save as PDF + Store in Supabase
    │
    ├─→ Tenant sign digitally
    │   ├─ Use Signature Pad component
    │   ├─ Save signature as image
    │   └─ Mark form as signed
    │
    ├─→ Update Asset status
    │   └─ AVAILABLE → IN_USE
    │
    ├─→ Create Asset History entry
    │   └─ Type: HANDED_OVER, From: Warehouse, To: Room 101
    │
    └─→ Handover completed ✓

Handover Document Template:
┌──────────────────────────────────────┐
│    BIÊN BẢN BÀN GIAO TÀI SẢN         │
├──────────────────────────────────────┤
│ Phòng: 101, Building A               │
│ Tenant: Nguyễn Văn A                 │
│ Ngày: 2025-11-18                     │
├──────────────────────────────────────┤
│ STT | Item        | Status | Note    │
│ 1   | Giường 1    | Tốt    |         │
│ 2   | Tủ quần áo  | Tốt    |         │
│ 3   | Bàn làm việc| Tốt    |         │
│ 4   | Máy lạnh    | Tốt    |         │
├──────────────────────────────────────┤
│ Người giao: _____ | Ngày: _____      │
│ Người nhận: _____ | Ngày: _____      │
└──────────────────────────────────────┘
```

### Asset Handover on Check-out

```
BÀNGIAO TÀI SẢN KHI CHECK-OUT:

Timeline:
Lease ended / Tenant leaving
    │
    ├─→ Manager create Check-out Handover
    │   ├─ Chọn phòng (*)
    │   ├─ Danh sách tài sản (auto-fill từ check-in)
    │   └─ Kiểm tra điều kiện từng item
    │
    ├─→ Inspect asset condition
    │   ├─ Status: Good / Damaged / Missing
    │   ├─ Damage notes (nếu có)
    │   ├─ Repair cost estimate (nếu cần)
    │   └─ Take photos
    │
    ├─→ Generate Check-out Biên bản
    │   ├─ Item condition
    │   ├─ Damages & costs
    │   ├─ Missing items
    │   └─ Return/Deduct from deposit
    │
    ├─→ Get signatures
    │   ├─ Tenant sign (acknowledgment)
    │   └─ Staff sign
    │
    ├─→ Update Assets
    │   ├─ Status: IN_USE → AVAILABLE (nếu OK)
    │   ├─ Status: IN_USE → DAMAGED (nếu cần sửa)
    │   └─ Location: Back to Warehouse
    │
    ├─→ Update Lease
    │   ├─ Link check-out handover
    │   ├─ Record damages & costs
    │   └─ Deduct from deposit
    │
    └─→ Check-out completed ✓
```

### Asset Movement (Di chuyển tài sản)

```
DI CHUYỂN TÀI SẢN:

Warehouse → Room:
    │
    ├─→ Select asset in warehouse
    ├─→ Choose destination room
    ├─→ Update status: IN_USE
    ├─→ Create movement log:
    │   ├─ From: Warehouse_ID
    │   ├─ To: Room_ID
    │   ├─ Date: today
    │   └─ Moved_by: User_ID
    └─→ Update asset location

Room → Room (Move between rooms):
    │
    ├─→ Select asset in room A
    ├─→ Choose room B
    ├─→ Status: IN_USE (unchanged)
    ├─→ Create movement log:
    │   ├─ From: Room_A_ID
    │   ├─ To: Room_B_ID
    │   ├─ Date: today
    │   └─ Moved_by: User_ID
    └─→ Asset moved

Room → Warehouse (Return/Repair):
    │
    ├─→ Select asset in room
    ├─→ Reason: Return / Damaged / Maintenance
    ├─→ Update status:
    │   ├─ Return → AVAILABLE
    │   └─ Damaged → DAMAGED
    ├─→ Create movement log
    └─→ Asset returned

API:
POST /api/assets/{id}/move {
  from_location_type: 'WAREHOUSE' | 'ROOM'
  from_location_id: string
  to_location_type: 'WAREHOUSE' | 'ROOM'
  to_location_id: string
  reason?: string
  moved_by: user_id
}
```

---

## 🔧 MAINTENANCE & REPAIR

### Maintenance Tracking

```
LẬP LỊCH & THEO DÕI BẢO TRÌ:

Schedule Maintenance:
    │
    ├─→ Select asset or category
    ├─→ Form:
    │   ├─ Asset (*)
    │   ├─ Maintenance type: Cleaning / Calibration / Inspection
    │   ├─ Scheduled date (*)
    │   ├─ Technician assigned
    │   ├─ Estimated cost
    │   └─ Notes
    │
    ├─→ Save maintenance record
    └─→ Notification sent to technician

Record Maintenance:
    │
    ├─→ Technician receives schedule
    ├─→ Complete maintenance
    ├─→ Fill report:
    │   ├─ Actual date completed
    │   ├─ Work done (description)
    │   ├─ Parts replaced (if any)
    │   ├─ Actual cost
    │   ├─ Status after maintenance: Working / Need_Repair
    │   └─ Photos (before/after)
    │
    ├─→ Save maintenance record
    ├─→ Update asset history
    └─→ Next maintenance date (if scheduled)

Database:
CREATE TABLE asset_maintenance (
  id uuid PRIMARY KEY,
  asset_id uuid REFERENCES assets,
  maintenance_type VARCHAR(50),
  scheduled_date DATE,
  completed_date DATE,
  technician_id uuid REFERENCES auth.users,
  work_description TEXT,
  parts_replaced TEXT,
  estimated_cost DECIMAL,
  actual_cost DECIMAL,
  status VARCHAR(20), -- SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED
  notes TEXT,
  created_at TIMESTAMP
);
```

---

## 🆘 ISSUES & TASKS MANAGEMENT

### Issues 4-Step Workflow

```
QUY TRÌNH 4 BƯỚC:

┌────────────────────────────────────────┐
│ STEP 1: BÁOCÁO (Report Issue)          │
├────────────────────────────────────────┤
│ Tenant gọi điện / Gửi Zalo / Ứng dụng │
│     │                                  │
│     ├─→ Select issue category (*)      │
│     ├─→ Description (*)                │
│     ├─→ Location: Room number (*)      │
│     ├─→ Attachments: Photos/videos     │
│     ├─→ Preferred contact method       │
│     └─→ Click "Submit Issue"           │
│                                        │
│ Auto: Create Issue record with         │
│   ├─ Status: NEW                       │
│   ├─ Priority: AUTO (based on category)│
│   ├─ Created_at: now                   │
│   └─ Created_by: Tenant/Staff          │
│                                        │
│ Notification: SMS/Zalo → Management   │
└────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────┐
│ STEP 2: TIẾPNHẬN (Accept)              │
├────────────────────────────────────────┤
│ Manager/Supervisor reviews             │
│     │                                  │
│     ├─→ View issue details             │
│     ├─→ Assess priority (override?)    │
│     ├─→ Estimate SLA:                  │
│     │   ├─ LOW: 3 days                 │
│     │   ├─ MEDIUM: 24 hours            │
│     │   ├─ HIGH: 8 hours               │
│     │   └─ URGENT: 2 hours             │
│     │                                  │
│     ├─→ Assign technician (*)          │
│     ├─→ Set expected date              │
│     └─→ Click "Accept & Assign"        │
│                                        │
│ Auto: Update issue                     │
│   ├─ Status: ASSIGNED                  │
│   ├─ Assigned_to: Tech_ID              │
│   ├─ Assigned_at: now                  │
│   └─ Assigned_by: Manager_ID           │
│                                        │
│ Notification: SMS/Zalo → Technician   │
└────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────┐
│ STEP 3: XỬLÝ (Work in Progress)        │
├────────────────────────────────────────┤
│ Technician works on issue              │
│     │                                  │
│     ├─→ Update status: IN_PROGRESS     │
│     ├─→ Log start time                 │
│     ├─→ Add comments/updates:          │
│     │   ├─ What I did                  │
│     │   ├─ Photos (before/after)       │
│     │   ├─ Parts used (with cost)      │
│     │   └─ Time spent                  │
│     │                                  │
│     ├─→ Track labor hours              │
│     ├─→ Track material costs           │
│     └─→ Request approval (if needed)   │
│                                        │
│ Notification: Comments → Tenant/Manager
└────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────┐
│ STEP 4: HOÀNTHÀNH (Resolved)           │
├────────────────────────────────────────┤
│ Technician completes work              │
│     │                                  │
│     ├─→ Fill completion form:          │
│     │   ├─ Work completed description  │
│     │   ├─ Photos (final state)        │
│     │   ├─ Total cost (labor + parts)  │
│     │   └─ Status: RESOLVED            │
│     │                                  │
│     ├─→ Get tenant approval            │
│     │   ├─ Tenant inspect work         │
│     │   ├─ Rate satisfaction (1-5 ⭐)  │
│     │   ├─ Add feedback/comments       │
│     │   └─ Click "Approve"             │
│     │                                  │
│     └─→ Mark as CLOSED                 │
│                                        │
│ Auto: Final calculations               │
│   ├─ Total hours worked                │
│   ├─ Total cost (labor + parts)        │
│   ├─ SLA compliance check              │
│   ├─ Calculate service fee             │
│   └─ Link to tenant lease/invoice      │
│                                        │
│ Notification: Issue closed → All      │
└────────────────────────────────────────┘
```

### Issue Categories & Priorities

```
LOẠI SỰ CỐ (Categories):
├─ Điện (Electrical)
│  ├─ Không có điện
│  ├─ Bóng đèn cháy
│  ├─ Ổ cắm hỏng
│  └─ Bảng điều khiển lỗi
├─ Nước (Water)
│  ├─ Nước bị cắt
│  ├─ Nước chảy yếu
│  ├─ Vòi nước bị rò rỉ
│  └─ Bồn cầu hỏng
├─ WiFi/Internet
│  ├─ WiFi mất tín hiệu
│  ├─ Kết nối chậm
│  └─ Router hỏng
├─ Máy lạnh (AC)
│  ├─ Máy lạnh không tắt được
│  ├─ Không lạnh
│  ├─ Rò rỉ nước
│  └─ Gây tiếng ồn
├─ Nội thất (Furniture)
│  ├─ Giường gãy
│  ├─ Tủ hỏng
│  ├─ Bàn chân lỏng
│  └─ Bọc da tróc
├─ Vệ sinh/Thoát nước (Plumbing)
│  ├─ Thoát nước chậm
│  ├─ Vồng/cong
│  ├─ Ghế rửa bị bẩn
│  └─ Vòi sen hỏng
├─ Cửa/Khóa (Door/Lock)
│  ├─ Khóa hỏng
│  ├─ Cửa bị kẹt
│  ├─ Lõi khóa bị gãy
│  └─ Bản lề lỏng
└─ Khác (Others)
   ├─ Cửa sổ vỡ
   ├─ Tường thấm nước
   └─ Vấn đề khác

PRIORITY LEVELS:
├─ LOW (Thấp)
│  └─ SLA: 3 days
│     ├─ Bóng đèn cháy, Vấn đề trang trí
│     └─ Có thể chờ
│
├─ MEDIUM (Trung bình)
│  └─ SLA: 24 hours
│     ├─ Nước chảy yếu, WiFi chậm
│     └─ Ảnh hưởng thoải mái
│
├─ HIGH (Cao)
│  └─ SLA: 8 hours
│     ├─ Không có nước, AC không lạnh
│     ├─ Khóa hỏng, Cửa bị kẹt
│     └─ Ảnh hưởng cuộc sống hàng ngày
│
└─ URGENT (Khẩn cấp)
   └─ SLA: 2 hours
      ├─ Không có điện, Thoát nước tắc
      ├─ Rò rỉ nước lớn, Cháy/Nguy hiểm
      └─ Ảnh hưởng ngay lập tức, Mất an toàn

Note: Có thể auto-assign priority dựa vào category,
      nhưng cho phép manager override
```

### Issue Status Workflow

```
WORKFLOW TRẠNG THÁI:

NEW
  ├─ Auto-created when tenant reports
  ├─ Notification sent to management
  └─ Duration: < 1 hour

     ↓ (Manager assign)

ASSIGNED
  ├─ Technician assigned
  ├─ Notification sent to technician
  ├─ Expected completion date set
  └─ Duration: varies by priority

     ↓ (Technician accepts)

IN_PROGRESS
  ├─ Technician working on issue
  ├─ Can update status with comments
  ├─ Can request for approval (if needed)
  ├─ Track labor hours & material costs
  └─ Duration: varies

     ↓ (Technician marks done)

RESOLVED
  ├─ Work completed by technician
  ├─ Awaiting tenant approval/feedback
  ├─ Tenant rates satisfaction (1-5 stars)
  └─ Duration: 24-48 hours for approval

     ↓ (Tenant approves or disputes)

CLOSED
  ├─ Issue fully resolved & approved
  ├─ Calculate final costs
  ├─ SLA compliance recorded
  └─ Link to tenant billing

SPECIAL STATES:
├─ ON_HOLD: Awaiting parts/approval, SLA paused
├─ ESCALATED: Requires management attention
├─ CANCELLED: Resolved without action or tenant cancelled
└─ REOPENED: Tenant reports same issue within 7 days
```

---

## 📊 DATABASE SCHEMA

### Assets Table

```sql
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code VARCHAR(50) UNIQUE NOT NULL,
  asset_name VARCHAR(100) NOT NULL,
  category_id uuid REFERENCES asset_categories(id),
  supplier_id uuid REFERENCES suppliers(id),
  warehouse_id uuid REFERENCES warehouses(id),
  current_location_type VARCHAR(20), -- WAREHOUSE, ROOM
  current_location_id uuid, -- warehouse_id or room_id
  purchase_price DECIMAL(12,2),
  purchase_date DATE,
  expected_lifespan_years INT,
  image_url VARCHAR(255), -- Supabase Storage URL
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('AVAILABLE', 'IN_USE', 'DAMAGED', 'RETIRED'))
);

CREATE INDEX idx_assets_category ON assets(category_id);
CREATE INDEX idx_assets_status ON assets(status);
CREATE INDEX idx_assets_location ON assets(current_location_type, current_location_id);
```

### Asset History Table

```sql
CREATE TABLE asset_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  action_type VARCHAR(50) NOT NULL, -- CREATED, MOVED, HANDED_OVER, RETURNED, MAINTENANCE, STATUS_CHANGED
  from_location_type VARCHAR(20),
  from_location_id uuid,
  to_location_type VARCHAR(20),
  to_location_id uuid,
  action_date TIMESTAMP DEFAULT NOW(),
  action_by uuid REFERENCES auth.users,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_asset_history_asset_id ON asset_history(asset_id);
CREATE INDEX idx_asset_history_date ON asset_history(action_date);
```

### Asset Handover Table

```sql
CREATE TABLE asset_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_type VARCHAR(20) NOT NULL, -- CHECK_IN, CHECK_OUT
  lease_id uuid REFERENCES leases(id),
  room_id uuid REFERENCES rooms(id),
  handover_date DATE NOT NULL,
  staff_id uuid NOT NULL REFERENCES auth.users,
  tenant_id uuid REFERENCES residents(id),
  handover_document_url VARCHAR(255), -- PDF stored in Supabase
  staff_signature TEXT, -- base64 image
  tenant_signature TEXT, -- base64 image
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- DRAFT, SIGNED, COMPLETED
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE handover_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id uuid NOT NULL REFERENCES asset_handovers(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  condition_on_handover VARCHAR(20), -- GOOD, DAMAGED, MISSING
  damage_description TEXT,
  estimated_repair_cost DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_handovers_lease ON asset_handovers(lease_id);
CREATE INDEX idx_handovers_room ON asset_handovers(room_id);
```

### Issues Table

```sql
CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_code VARCHAR(50) UNIQUE NOT NULL,
  category_id uuid REFERENCES issue_categories(id),
  room_id uuid NOT NULL REFERENCES rooms(id),
  building_id uuid NOT NULL REFERENCES buildings(id),
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  status VARCHAR(20) NOT NULL DEFAULT 'NEW',

  reported_by uuid NOT NULL REFERENCES auth.users, -- tenant or staff
  reported_at TIMESTAMP DEFAULT NOW(),

  assigned_to uuid REFERENCES auth.users, -- technician
  assigned_at TIMESTAMP,
  assigned_by uuid REFERENCES auth.users,

  sla_due_date TIMESTAMP, -- calculated from priority
  expected_completion_date DATE,
  actual_completion_date DATE,

  estimated_cost DECIMAL(10,2),
  actual_cost DECIMAL(10,2),
  labor_hours DECIMAL(10,2),
  labor_rate DECIMAL(10,2),

  rating INT, -- 1-5 stars
  feedback TEXT,

  attachments_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  CONSTRAINT valid_status CHECK (status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ON_HOLD', 'ESCALATED', 'CANCELLED', 'REOPENED'))
);

CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_priority ON issues(priority);
CREATE INDEX idx_issues_assigned_to ON issues(assigned_to);
CREATE INDEX idx_issues_room ON issues(room_id);
CREATE INDEX idx_issues_building ON issues(building_id);
CREATE INDEX idx_issues_sla_due ON issues(sla_due_date);
```

### Issue Comments & Timeline

```sql
CREATE TABLE issue_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  commented_by uuid NOT NULL REFERENCES auth.users,
  comment_text TEXT NOT NULL,
  attachment_url VARCHAR(255), -- optional image/file
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE issue_status_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20),
  changed_by uuid NOT NULL REFERENCES auth.users,
  changed_at TIMESTAMP DEFAULT NOW(),
  reason TEXT
);

CREATE INDEX idx_comments_issue ON issue_comments(issue_id);
CREATE INDEX idx_status_changes_issue ON issue_status_changes(issue_id);
```

### Issue Categories

```sql
CREATE TABLE issue_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  default_priority VARCHAR(20) DEFAULT 'MEDIUM',
  sla_hours INT, -- auto-calculated from priority
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sample data
INSERT INTO issue_categories (name, default_priority, sla_hours)
VALUES
  ('Điện', 'HIGH', 8),
  ('Nước', 'HIGH', 8),
  ('Máy lạnh', 'MEDIUM', 24),
  ('Nội thất', 'MEDIUM', 24),
  ('Cửa/Khóa', 'HIGH', 8),
  ('WiFi', 'LOW', 72),
  ('Vệ sinh', 'MEDIUM', 24),
  ('Khác', 'MEDIUM', 24);
```

---

## 🔀 FLOW DIAGRAMS

### Asset Handover Flow (Check-in)

```
Tenant signing lease
         │
         ├─ Manager initiates handover
         │
         ├─ Select assets to deliver
         │
         ├─ Generate biên bản
         │
         ├─ Print/Display form
         │
         ├─ Manager signs (Người giao)
         │
         ├─ Tenant inspects items
         │
         ├─ Tenant signs (Người nhận)
         │
         ├─ Capture signature image
         │
         ├─ Save to Supabase Storage
         │
         ├─ Update asset status: AVAILABLE → IN_USE
         │
         ├─ Create audit logs for each asset
         │
         └─ Generate PDF & save
            └─ Email/SMS confirmation to tenant

```

### Issue Resolution Flow

```
Tenant reports issue (NEW)
         │
         ├─ Auto notify management
         │
         ├─ Manager reviews + assigns (ASSIGNED)
         │
         ├─ Technician accepts + starts (IN_PROGRESS)
         │
         ├─ Technician posts updates/comments
         │
         ├─ Technician marks done (RESOLVED)
         │
         ├─ Tenant reviews work
         │
         ├─ Tenant rates (1-5 stars) + feedback
         │
         ├─ Tenant approves (CLOSED) or disputes (REOPENED)
         │
         ├─ Calculate costs & SLA
         │
         └─ Add to invoice (if chargeable)
```

### Asset Maintenance Schedule

```
Periodic maintenance due
         │
         ├─ System checks schedule
         │
         ├─ Create maintenance record
         │
         ├─ Assign to technician
         │
         ├─ Notify technician
         │
         ├─ Technician completes work
         │
         ├─ Update asset history
         │
         ├─ Capture photos (before/after)
         │
         ├─ Record costs
         │
         └─ Calculate next maintenance date
```

---

## 💼 BUSINESS LOGIC & RULES

### SLA Tracking

```
Priority → SLA Hours:
├─ LOW        → 72 hours (3 days)
├─ MEDIUM     → 24 hours
├─ HIGH       → 8 hours
└─ URGENT     → 2 hours

SLA Calculation:
sla_due_date = created_at + priority_sla_hours

Escalation Rules:
├─ If current_time > sla_due_date + 25%
│  └─ Status: ESCALATED
│     └─ Notify manager immediately
│
├─ If current_time > sla_due_date + 50%
│  └─ Send second escalation
│
└─ If current_time > sla_due_date + 100%
   └─ Breach: Create alert, Impact score ↑

SLA Compliance Report:
├─ On-time: completed_date ≤ sla_due_date
├─ Late: completed_date > sla_due_date
└─ Track compliance % per technician
```

### Cost Calculation

```
Total Issue Cost = Labor Cost + Material Cost

Labor Cost = labor_hours × labor_rate

Material Cost = SUM(parts_used.cost)

Tenant Billing:
├─ If issue caused by maintenance: FREE (building cost)
├─ If issue caused by tenant misuse: BILLABLE (add to invoice)
├─ If unknown: Manager decides

Example:
  Labor: 2.5 hours × 150,000 VND = 375,000 VND
  Parts: 100,000 VND
  Total: 475,000 VND
```

### Asset Depreciation

```
Depreciation Method: Straight-line

Annual Depreciation = Purchase Price / Expected Lifespan

Current Value = Purchase Price - (Depreciation × Years Since Purchase)

Example:
  Asset: AC (Máy lạnh)
  Purchase Price: 5,000,000 VND
  Expected Lifespan: 5 years
  Annual Depreciation: 1,000,000 VND

  Year 1: 4,000,000 VND
  Year 2: 3,000,000 VND
  Year 3: 2,000,000 VND
  Year 4: 1,000,000 VND
  Year 5: 0 VND (retire)
```

---

## 🏗️ COMPONENT STRUCTURE

### Asset Management Components

```typescript
// src/components/assets/
├─ AssetList.tsx              // List all assets with filters
├─ AssetForm.tsx              // Create/Edit asset
├─ AssetDetails.tsx           // View asset history
├─ AssetCategories.tsx        // Manage categories
├─ Warehouses.tsx             // Manage warehouses
│
├─ handover/
│  ├─ HandoverForm.tsx        // Create handover
│  ├─ HandoverList.tsx        // List handovers
│  ├─ HandoverDocument.tsx    // PDF biên bản template
│  └─ SignaturePad.tsx        // Signature capture
│
├─ movement/
│  ├─ MoveAssetForm.tsx       // Move asset location
│  └─ MovementHistory.tsx     // View movement log
│
└─ maintenance/
   ├─ MaintenanceSchedule.tsx // Schedule maintenance
   ├─ MaintenanceList.tsx     // List maintenance records
   └─ MaintenanceReport.tsx   // Technician report form
```

### Issue Management Components

```typescript
// src/components/issues/
├─ IssueReport.tsx            // Tenant reports issue
├─ IssueList.tsx              // List all issues with filters
├─ IssueDetails.tsx           // View issue detail
├─ IssueForm.tsx              // Manager creates/edits issue
├─ IssueAssign.tsx            // Assign issue to technician
│
├─ workflow/
│  ├─ IssueTimeline.tsx       // Status change timeline
│  ├─ IssueComments.tsx       // Comments section
│  ├─ IssueStatusUpdate.tsx   // Update status
│  └─ IssueFeedback.tsx       // Tenant rating & feedback
│
└─ reports/
   ├─ IssueAnalytics.tsx      // Dashboard with metrics
   └─ SLAReport.tsx           // SLA compliance report
```

---

## 🔌 API ENDPOINTS

### Asset APIs

```
ASSETS:
POST   /api/assets                    Create asset
GET    /api/assets                    List assets (with filters)
GET    /api/assets/{id}               Get asset detail
PUT    /api/assets/{id}               Update asset
DELETE /api/assets/{id}               Soft delete asset

ASSET HISTORY:
GET    /api/assets/{id}/history       Get asset audit trail
GET    /api/asset-movement            List all movements

HANDOVERS:
POST   /api/handovers                 Create handover
GET    /api/handovers                 List handovers
GET    /api/handovers/{id}            Get handover detail
PUT    /api/handovers/{id}            Update handover
POST   /api/handovers/{id}/sign       Add signature
GET    /api/handovers/{id}/pdf        Download PDF

MAINTENANCE:
POST   /api/maintenance               Schedule maintenance
GET    /api/maintenance               List maintenance
PUT    /api/maintenance/{id}          Update maintenance record
GET    /api/maintenance/{id}/report   Get completion report

CATEGORIES:
GET    /api/asset-categories          List all categories
POST   /api/asset-categories          Create category

WAREHOUSES:
GET    /api/warehouses                List all warehouses
POST   /api/warehouses                Create warehouse
```

### Issue APIs

```
ISSUES:
POST   /api/issues                    Create issue
GET    /api/issues                    List issues (with filters)
GET    /api/issues/{id}               Get issue detail
PUT    /api/issues/{id}               Update issue
POST   /api/issues/{id}/assign        Assign to technician
POST   /api/issues/{id}/status        Update status
POST   /api/issues/{id}/resolve       Mark resolved
POST   /api/issues/{id}/close         Close issue
POST   /api/issues/{id}/rate          Rate & feedback

COMMENTS:
POST   /api/issues/{id}/comments      Add comment
GET    /api/issues/{id}/comments      List comments
DELETE /api/issues/{id}/comments/{cid} Delete comment

REPORTS:
GET    /api/issues/reports/sla        SLA compliance
GET    /api/issues/reports/by-technician
GET    /api/issues/reports/by-category
GET    /api/issues/reports/metrics    Overall metrics
```

---

## ✅ TESTING CHECKLIST

### Asset Management Tests

```
Asset CRUD:
  ✓ Create asset with all fields
  ✓ Validate unique asset code
  ✓ Upload image to Supabase
  ✓ Edit asset details
  ✓ Soft delete asset
  ✓ View asset history
  ✓ Filter assets by category/status/location

Asset Handover:
  ✓ Create check-in handover
  ✓ Create check-out handover
  ✓ Generate PDF biên bản
  ✓ Capture signatures
  ✓ Verify signature capture
  ✓ Update asset status on handover
  ✓ Update multiple assets in one handover
  ✓ Email PDF to tenant

Asset Movement:
  ✓ Move asset from warehouse to room
  ✓ Move asset between rooms
  ✓ Move asset back to warehouse
  ✓ Track movement history
  ✓ Update asset location
  ✓ Validate location exists

Maintenance:
  ✓ Schedule maintenance
  ✓ Record maintenance completion
  ✓ Upload before/after photos
  ✓ Calculate next maintenance date
  ✓ Notify technician
  ✓ Track maintenance costs
```

### Issue Management Tests

```
Issue Reporting:
  ✓ Tenant creates issue
  ✓ Auto-assign priority by category
  ✓ Create issue code (auto-generated)
  ✓ Notification sent to manager
  ✓ Attach photos/videos
  ✓ Validate required fields

Issue Workflow:
  ✓ Assign issue to technician
  ✓ Update status: NEW → ASSIGNED
  ✓ Technician marks IN_PROGRESS
  ✓ Technician adds comments + photos
  ✓ Technician marks RESOLVED
  ✓ Tenant rates satisfaction (1-5)
  ✓ Close issue (CLOSED)
  ✓ Calculate total cost

SLA Tracking:
  ✓ Calculate SLA due date
  ✓ Track SLA compliance
  ✓ Send escalation notifications
  ✓ Mark SLA breach
  ✓ Generate SLA report

Cost Tracking:
  ✓ Calculate labor cost
  ✓ Add material costs
  ✓ Total cost calculation
  ✓ Track cost per technician
  ✓ Bill tenant (if applicable)
  ✓ Add to invoice
```

---

## 📝 NOTES

### Future Enhancements

- Multi-language support (Vietnamese, English)
- Mobile app for technician check-in/out with GPS
- QR code scanning for assets & rooms
- Automated maintenance schedules (calendar sync)
- SMS/Zalo notifications (Phase 2)
- Issue templates for common problems
- Spare parts inventory management
- Contractor integration (external technicians)
- Warranty tracking & expiration alerts
- Asset insurance management
- Preventive maintenance recommendations (AI)

### Considerations

- Handle large image/PDF uploads efficiently (chunking)
- RLS policies for role-based access (tenant can only see own issues)
- Audit trail immutability (no deletion of history)
- Backup signature images securely
- Handle signature pad on mobile & desktop
- Batch operations for multiple assets
- Handle concurrent updates (optimistic locking)

---

## 🎯 NEXT STEPS

1. ✅ Design Asset Management module
2. ✅ Design Issue Management module
3. ✅ Create database schema
4. 📋 Implement Asset CRUD operations
5. 📋 Implement Asset Handover flow
6. 📋 Implement Issue reporting & assignment
7. 📋 Implement Issue workflow & SLA tracking
8. 📋 Build components & forms
9. 📋 Setup API endpoints
10. 📋 Create dashboard & reports
11. 📋 Write tests
12. 📋 Deploy & monitor

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [06-BILLING-FLOW.md](./06-BILLING-FLOW.md) | **Next**: [08-RESIDENT-MANAGEMENT.md](./08-RESIDENT-MANAGEMENT.md)
