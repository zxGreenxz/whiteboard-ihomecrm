# DATABASE SCHEMA - SUPABASE
## crm - Hệ thống quản lý bất động sản

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Sơ đồ quan hệ](#sơ-đồ-quan-hệ)
3. [Chi tiết các bảng](#chi-tiết-các-bảng)
4. [Row Level Security (RLS)](#row-level-security-rls)
5. [Indexes & Performance](#indexes--performance)
6. [Triggers & Functions](#triggers--functions)
7. [SQL Migration Scripts](#sql-migration-scripts)
8. [TypeScript Types](#typescript-types)

---

## 🎯 TỔNG QUAN

### Nguyên tắc thiết kế
1. **Phân cấp rõ ràng**: Area → Building → Room → Bed (optional)
2. **Audit trail**: Tất cả bảng có `created_at`, `updated_at`
3. **Soft delete**: Sử dụng `deleted_at` thay vì xóa thật
4. **User isolation**: Mỗi user chỉ thấy dữ liệu của mình (RLS)
5. **Flexible metadata**: Sử dụng JSONB cho dữ liệu linh hoạt

### Quy ước đặt tên
- **Bảng**: Số nhiều, lowercase, snake_case (vd: `buildings`, `contract_services`)
- **Cột**: Lowercase, snake_case (vd: `created_at`, `total_amount`)
- **Foreign key**: `{table}_id` (vd: `building_id`, `user_id`)
- **Enum**: UPPER_SNAKE_CASE (vd: `ACTIVE`, `PENDING_APPROVAL`)

---

## 🗺️ SƠ ĐỒ QUAN HỆ

### Sơ đồ tổng thể

```
┌────────────────────────────────────────────────────────────────────┐
│                      SUPABASE AUTH                                 │
│                    auth.users (built-in)                           │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           │ user_id
                           │
        ┌──────────────────┼──────────────────┬─────────────────┬──────────────────┐
        │                  │                  │                 │                  │
        ▼                  ▼                  ▼                 ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  ┌────────────────┐
│   profiles   │   │    areas     │   │  buildings   │   │   tenants    │  │   expenses     │
└──────────────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘  └────────────────┘
                          │                   │                   │
                          │ area_id           │ building_id       │ tenant_id
                          └───────────────────┤                   │
                                              ▼                   │
                                       ┌──────────────┐          │
                                       │    rooms     │          │
                                       └──────┬───────┘          │
                          │                   │
                          │ room_id           │
              ┬───────────┴───────────┬       │
              │                       │       │
              ▼                       ▼       │
      ┌──────────────┐        ┌──────────────┴──┐
      │     beds     │        │   contracts      │
      └──────┬───────┘        └──────┬───────────┘
             │                       │
             │ bed_id                │ contract_id
             │                       │
             └───────────┬───────────┴─────────────┬────────────┐
                         │                         │            │
                         ▼                         ▼            ▼
                 ┌──────────────┐         ┌──────────────┐  ┌──────────────┐
                 │  contract_   │         │   invoices   │  │   deposits   │
                 │  services    │         └──────┬───────┘  └──────────────┘
                 └──────────────┘                │
                                                 │ invoice_id
                                  ┌──────────────┼──────────────┐
                                  │              │              │
                                  ▼              ▼              ▼
                          ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                          │   payments   │  │invoice_items │  │meter_readings│
                          └──────────────┘  └──────────────┘  └──────────────┘

┌──────────────┐
│   services   │ (Global master data)
└──────────────┘

┌──────────────┐
│  settings    │ (System configuration)
└──────────────┘

┌────────────────────┐
│ signature_templates│ (Mẫu chữ ký điện tử)
└────────────────────┘
```

---

## 📊 CHI TIẾT CÁC BẢNG

### 1. PROFILES (Thông tin user)

Mở rộng thông tin từ `auth.users`

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  avatar_url TEXT,
  company_name TEXT,
  address TEXT,
  -- Settings
  default_payment_due_days INTEGER DEFAULT 5,
  timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
  language TEXT DEFAULT 'vi',
  -- Subscription info
  subscription_plan TEXT DEFAULT 'trial', -- trial, basic, pro, enterprise
  subscription_expires_at TIMESTAMPTZ,
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT profiles_phone_format CHECK (phone ~ '^[0-9]{10,11}$')
);

-- Indexes
CREATE INDEX idx_profiles_phone ON profiles(phone);
CREATE INDEX idx_profiles_email ON profiles(email);

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);
```

---

### 2. AREAS (Khu vực)

Khu vực là cấp quản lý cao nhất, dùng để nhóm các tòa nhà theo khu vực địa lý (Quận 1, Quận 2, Khu A, Khu B, ...).

```sql
CREATE TABLE areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL, -- "Khu vực Quận 1", "Khu A"
  code TEXT, -- Mã khu vực (Q1, KHA, ...) - auto-generated hoặc manual
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT areas_name_not_empty CHECK (char_length(name) > 0)
);

-- Indexes
CREATE INDEX idx_areas_user_id ON areas(user_id);
CREATE INDEX idx_areas_status ON areas(status);
CREATE INDEX idx_areas_code ON areas(code);
CREATE INDEX idx_areas_deleted_at ON areas(deleted_at);

-- Full-text search
CREATE INDEX idx_areas_search ON areas USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(description, ''))
);

-- RLS
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own areas"
  ON areas FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own areas"
  ON areas FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own areas"
  ON areas FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own areas"
  ON areas FOR DELETE
  USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER set_areas_updated_at
  BEFORE UPDATE ON areas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

---

### 3. BUILDINGS (Tòa nhà)

```sql
CREATE TYPE building_status AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
CREATE TYPE building_type AS ENUM ('APARTMENT', 'DORMITORY', 'HOUSE', 'OFFICE', 'SLEEPBOX', 'HOMESTAY');

CREATE TABLE buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  area_id UUID REFERENCES areas(id) ON DELETE SET NULL, -- NEW: Thuộc khu vực nào (optional)

  -- Basic info
  name TEXT NOT NULL,
  code TEXT, -- Mã tòa nhà (optional)
  type building_type NOT NULL DEFAULT 'APARTMENT',
  status building_status NOT NULL DEFAULT 'ACTIVE',

  -- Address
  province TEXT NOT NULL, -- Tỉnh/Thành phố
  district TEXT NOT NULL, -- Quận/Huyện
  ward TEXT NOT NULL,     -- Phường/Xã
  street_address TEXT,    -- Số nhà, tên đường

  -- Configuration
  total_floors INTEGER DEFAULT 1,
  total_rooms INTEGER DEFAULT 0, -- Auto calculated

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb, -- Array of image URLs
  amenities JSONB DEFAULT '[]'::jsonb, -- [wifi, parking, elevator, ...]

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT buildings_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT buildings_total_floors_positive CHECK (total_floors > 0)
);

-- Indexes
CREATE INDEX idx_buildings_user_id ON buildings(user_id);
CREATE INDEX idx_buildings_area_id ON buildings(area_id);
CREATE INDEX idx_buildings_status ON buildings(status);
CREATE INDEX idx_buildings_type ON buildings(type);
CREATE INDEX idx_buildings_deleted_at ON buildings(deleted_at);

-- Full-text search
CREATE INDEX idx_buildings_search ON buildings USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(code, '') || ' ' || coalesce(street_address, ''))
);

-- RLS
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own buildings"
  ON buildings FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own buildings"
  ON buildings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own buildings"
  ON buildings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own buildings"
  ON buildings FOR DELETE
  USING (auth.uid() = user_id);
```

---

### 3. ROOMS (Phòng)

```sql
CREATE TYPE room_status AS ENUM (
  'AVAILABLE',      -- Phòng trống
  'OCCUPIED',       -- Đang cho thuê
  'RESERVED',       -- Đã đặt cọc
  'MAINTENANCE',    -- Đang sửa chữa
  'UNAVAILABLE'     -- Không cho thuê
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL, -- Tên phòng (VD: P101, A-201)
  code TEXT, -- Mã phòng
  floor INTEGER NOT NULL DEFAULT 1,
  status room_status NOT NULL DEFAULT 'AVAILABLE',

  -- Room details
  area DECIMAL(10, 2), -- Diện tích (m2)
  max_occupants INTEGER DEFAULT 1, -- Số người tối đa

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL, -- Tiền thuê/tháng
  deposit_amount DECIMAL(15, 2) NOT NULL, -- Tiền cọc

  -- Metadata
  description TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  amenities JSONB DEFAULT '[]'::jsonb, -- [bed, ac, fridge, ...]

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT rooms_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT rooms_floor_positive CHECK (floor > 0),
  CONSTRAINT rooms_area_positive CHECK (area > 0),
  CONSTRAINT rooms_rent_price_positive CHECK (rent_price >= 0),
  CONSTRAINT rooms_deposit_amount_positive CHECK (deposit_amount >= 0),
  CONSTRAINT rooms_max_occupants_positive CHECK (max_occupants > 0)
);

-- Indexes
CREATE INDEX idx_rooms_building_id ON rooms(building_id);
CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_rooms_floor ON rooms(floor);
CREATE INDEX idx_rooms_deleted_at ON rooms(deleted_at);

-- Unique constraint: Tên phòng unique trong cùng tòa nhà
CREATE UNIQUE INDEX idx_rooms_unique_name_per_building
  ON rooms(building_id, name)
  WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view rooms of own buildings"
  ON rooms FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
        AND buildings.deleted_at IS NULL
    )
    AND deleted_at IS NULL
  );

CREATE POLICY "Users can insert rooms to own buildings"
  ON rooms FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update rooms of own buildings"
  ON rooms FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM buildings
      WHERE buildings.id = rooms.building_id
        AND buildings.user_id = auth.uid()
    )
  );
```

---

### 4. BEDS (Giường - cho KTX/Sleepbox)

```sql
CREATE TYPE bed_status AS ENUM (
  'AVAILABLE',
  'OCCUPIED',
  'RESERVED',
  'MAINTENANCE',
  'UNAVAILABLE'
);

CREATE TABLE beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL, -- Tên giường (VD: A1, Giường 1)
  code TEXT,
  status bed_status NOT NULL DEFAULT 'AVAILABLE',

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL,
  deposit_amount DECIMAL(15, 2) NOT NULL,

  -- Metadata
  description TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT beds_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT beds_rent_price_positive CHECK (rent_price >= 0),
  CONSTRAINT beds_deposit_amount_positive CHECK (deposit_amount >= 0)
);

-- Indexes
CREATE INDEX idx_beds_room_id ON beds(room_id);
CREATE INDEX idx_beds_status ON beds(status);
CREATE INDEX idx_beds_deleted_at ON beds(deleted_at);

-- Unique constraint
CREATE UNIQUE INDEX idx_beds_unique_name_per_room
  ON beds(room_id, name)
  WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE beds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view beds of own rooms"
  ON beds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN buildings ON buildings.id = rooms.building_id
      WHERE rooms.id = beds.room_id
        AND buildings.user_id = auth.uid()
        AND rooms.deleted_at IS NULL
        AND buildings.deleted_at IS NULL
    )
    AND deleted_at IS NULL
  );
```

---

### 5. SERVICES (Dịch vụ)

```sql
CREATE TYPE service_type AS ENUM (
  'FIXED',          -- Cố định (VD: Wifi 100k/phòng/tháng)
  'PER_PERSON',     -- Theo người (VD: Vệ sinh 50k/người/tháng)
  'PER_ROOM',       -- Theo phòng (VD: Wifi 100k/phòng)
  'METER_READING'   -- Theo chỉ số công tơ (VD: Điện, nước)
);

CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name TEXT NOT NULL, -- Tên dịch vụ (Điện, Nước, Wifi, Vệ sinh...)
  code TEXT, -- Mã dịch vụ
  type service_type NOT NULL,

  -- Pricing
  unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0, -- Đơn giá
  unit TEXT, -- Đơn vị (kWh, m3, người, phòng...)

  -- Configuration
  is_default BOOLEAN DEFAULT false, -- Dịch vụ mặc định cho hợp đồng mới
  is_mandatory BOOLEAN DEFAULT false, -- Bắt buộc

  -- Metadata
  description TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT services_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT services_unit_price_positive CHECK (unit_price >= 0)
);

-- Indexes
CREATE INDEX idx_services_user_id ON services(user_id);
CREATE INDEX idx_services_type ON services(type);
CREATE INDEX idx_services_is_default ON services(is_default);
CREATE INDEX idx_services_deleted_at ON services(deleted_at);

-- RLS
ALTER TABLE services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own services"
  ON services FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own services"
  ON services FOR ALL
  USING (auth.uid() = user_id);
```

---

### 6. TENANTS (Khách thuê)

```sql
CREATE TYPE tenant_status AS ENUM (
  'PROSPECT',    -- Khách tiềm năng
  'DEPOSITED',   -- Đã đặt cọc
  'ACTIVE',      -- Đang thuê
  'INACTIVE',    -- Đã chuyển đi
  'BLACKLIST'    -- Danh sách đen
);

CREATE TYPE id_type AS ENUM ('CCCD', 'CMND', 'PASSPORT', 'OTHER');

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Personal info
  full_name TEXT NOT NULL,
  id_number TEXT, -- Số CCCD/CMND
  id_type id_type DEFAULT 'CCCD',
  date_of_birth DATE,
  gender TEXT,

  -- Contact
  phone TEXT NOT NULL,
  email TEXT,

  -- Address
  permanent_address TEXT, -- Địa chỉ thường trú

  -- Status
  status tenant_status DEFAULT 'PROSPECT',

  -- Emergency contact
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relationship TEXT,

  -- Metadata
  notes TEXT,
  avatar_url TEXT,
  id_images JSONB DEFAULT '[]'::jsonb, -- Ảnh CCCD

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT tenants_full_name_not_empty CHECK (char_length(full_name) > 0),
  CONSTRAINT tenants_phone_format CHECK (phone ~ '^[0-9]{10,11}$')
);

-- Indexes
CREATE INDEX idx_tenants_user_id ON tenants(user_id);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_phone ON tenants(phone);
CREATE INDEX idx_tenants_id_number ON tenants(id_number);
CREATE INDEX idx_tenants_deleted_at ON tenants(deleted_at);

-- RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tenants"
  ON tenants FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own tenants"
  ON tenants FOR ALL
  USING (auth.uid() = user_id);
```

---

### 7. CONTRACTS (Hợp đồng)

```sql
CREATE TYPE contract_status AS ENUM (
  'DRAFT',        -- Nháp
  'ACTIVE',       -- Đang hiệu lực
  'EXTENDED',     -- Đã gia hạn (tạo hợp đồng mới)
  'TRANSFERRED',  -- Đã chuyển phòng
  'TERMINATED',   -- Đã thanh lý
  'EXPIRED'       -- Hết hạn
);

CREATE TYPE payment_cycle AS ENUM (
  'MONTHLY',      -- Hàng tháng
  'QUARTERLY',    -- 3 tháng
  'SEMI_ANNUAL',  -- 6 tháng
  'ANNUAL'        -- 1 năm
);

CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id UUID REFERENCES beds(id) ON DELETE RESTRICT,

  -- Contract info
  contract_number TEXT, -- Số hợp đồng
  status contract_status NOT NULL DEFAULT 'DRAFT',

  -- Dates
  signed_date DATE NOT NULL, -- Ngày ký
  start_date DATE NOT NULL, -- Ngày bắt đầu
  end_date DATE NOT NULL, -- Ngày kết thúc
  actual_end_date DATE, -- Ngày thực tế chuyển đi (khi thanh lý)

  -- Pricing
  rent_price DECIMAL(15, 2) NOT NULL, -- Tiền thuê/tháng
  payment_cycle payment_cycle DEFAULT 'MONTHLY',

  -- Deposit
  total_deposit DECIMAL(15, 2) NOT NULL DEFAULT 0, -- Tổng tiền cọc
  deposit_paid DECIMAL(15, 2) DEFAULT 0, -- Tiền đã cọc giữ chỗ
  deposit_remaining DECIMAL(15, 2) GENERATED ALWAYS AS (total_deposit - deposit_paid) STORED,

  -- Discounts (JSONB array)
  -- [{ month: 1, amount: 100000, reason: "Khuyến mãi tháng đầu" }, ...]
  discounts JSONB DEFAULT '[]'::jsonb,

  -- Meter readings (initial)
  initial_electricity_reading DECIMAL(10, 2),
  initial_water_reading DECIMAL(10, 2),

  -- Metadata
  notes TEXT,
  contract_file_url TEXT, -- PDF hợp đồng đã ký

  -- Related contracts
  parent_contract_id UUID REFERENCES contracts(id), -- Hợp đồng gốc (khi gia hạn/chuyển phòng)

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT contracts_dates_valid CHECK (start_date <= end_date),
  CONSTRAINT contracts_rent_price_positive CHECK (rent_price >= 0),
  CONSTRAINT contracts_deposit_positive CHECK (total_deposit >= 0),
  CONSTRAINT contracts_must_have_room_or_bed CHECK (
    (room_id IS NOT NULL AND bed_id IS NULL) OR
    (room_id IS NULL AND bed_id IS NOT NULL)
  )
);

-- Indexes
CREATE INDEX idx_contracts_user_id ON contracts(user_id);
CREATE INDEX idx_contracts_tenant_id ON contracts(tenant_id);
CREATE INDEX idx_contracts_room_id ON contracts(room_id);
CREATE INDEX idx_contracts_bed_id ON contracts(bed_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_start_date ON contracts(start_date);
CREATE INDEX idx_contracts_end_date ON contracts(end_date);
CREATE INDEX idx_contracts_parent_contract_id ON contracts(parent_contract_id);
CREATE INDEX idx_contracts_deleted_at ON contracts(deleted_at);

-- RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own contracts"
  ON contracts FOR ALL
  USING (auth.uid() = user_id);
```

---

### 8. CONTRACT_SERVICES (Dịch vụ theo hợp đồng)

```sql
CREATE TABLE contract_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Pricing (có thể override từ service)
  unit_price DECIMAL(15, 2) NOT NULL,

  -- For meter reading services
  initial_reading DECIMAL(10, 2), -- Chỉ số đầu

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT contract_services_unit_price_positive CHECK (unit_price >= 0),

  -- Unique: Mỗi service chỉ xuất hiện 1 lần trong 1 hợp đồng
  UNIQUE(contract_id, service_id)
);

-- Indexes
CREATE INDEX idx_contract_services_contract_id ON contract_services(contract_id);
CREATE INDEX idx_contract_services_service_id ON contract_services(service_id);

-- RLS
ALTER TABLE contract_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contract services"
  ON contract_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );
```

---

### 9. INVOICES (Hóa đơn)

```sql
CREATE TYPE invoice_status AS ENUM (
  'DRAFT',              -- Nháp (chưa duyệt)
  'PENDING_APPROVAL',   -- Chờ duyệt
  'APPROVED',           -- Đã duyệt (gửi cho khách)
  'PAID',               -- Đã thanh toán đủ
  'PARTIAL_PAID',       -- Thanh toán một phần
  'OVERDUE',            -- Quá hạn
  'CANCELLED'           -- Đã hủy
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,

  -- Invoice info
  invoice_number TEXT, -- Số hóa đơn (auto generated)
  title TEXT NOT NULL, -- Tiêu đề (VD: "Hóa đơn tháng 11/2024")

  -- Period
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,

  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE, -- Ngày lập
  due_date DATE NOT NULL, -- Hạn thanh toán
  paid_date DATE, -- Ngày thanh toán

  -- Status
  status invoice_status NOT NULL DEFAULT 'DRAFT',

  -- Amounts
  subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0, -- Tổng trước giảm giá
  discount_amount DECIMAL(15, 2) DEFAULT 0, -- Giảm giá
  tax_amount DECIMAL(15, 2) DEFAULT 0, -- Thuế (nếu có)
  total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0, -- Tổng cộng
  paid_amount DECIMAL(15, 2) DEFAULT 0, -- Đã thanh toán
  remaining_amount DECIMAL(15, 2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,

  -- Previous debt
  previous_debt DECIMAL(15, 2) DEFAULT 0, -- Nợ kỳ trước

  -- Metadata
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT invoices_period_valid CHECK (billing_period_start <= billing_period_end),
  CONSTRAINT invoices_total_amount_positive CHECK (total_amount >= 0),
  CONSTRAINT invoices_paid_amount_valid CHECK (paid_amount >= 0 AND paid_amount <= total_amount)
);

-- Indexes
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_contract_id ON invoices(contract_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_billing_period ON invoices(billing_period_start, billing_period_end);
CREATE INDEX idx_invoices_deleted_at ON invoices(deleted_at);

-- RLS
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own invoices"
  ON invoices FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own invoices"
  ON invoices FOR ALL
  USING (auth.uid() = user_id);
```

---

### 10. INVOICE_ITEMS (Chi tiết hóa đơn)

```sql
CREATE TYPE invoice_item_type AS ENUM (
  'RENT',           -- Tiền phòng
  'SERVICE',        -- Dịch vụ
  'PENALTY',        -- Phạt
  'DISCOUNT',       -- Giảm giá
  'OTHER'           -- Khác
);

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  -- Item info
  type invoice_item_type NOT NULL,
  service_id UUID REFERENCES services(id), -- NULL nếu không phải service
  description TEXT NOT NULL,

  -- Calculation
  quantity DECIMAL(10, 2) DEFAULT 1, -- Số lượng
  unit_price DECIMAL(15, 2) NOT NULL, -- Đơn giá
  amount DECIMAL(15, 2) NOT NULL, -- Thành tiền = quantity * unit_price

  -- For meter reading
  previous_reading DECIMAL(10, 2), -- Chỉ số cũ
  current_reading DECIMAL(10, 2), -- Chỉ số mới

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT invoice_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT invoice_items_amount_valid CHECK (amount >= 0)
);

-- Indexes
CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_service_id ON invoice_items(service_id);
CREATE INDEX idx_invoice_items_type ON invoice_items(type);

-- RLS
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view invoice items"
  ON invoice_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
        AND invoices.user_id = auth.uid()
    )
  );
```

---

### 11. PAYMENTS (Thanh toán)

```sql
CREATE TYPE payment_method AS ENUM (
  'CASH',           -- Tiền mặt
  'BANK_TRANSFER',  -- Chuyển khoản
  'MOMO',           -- Momo
  'VNPAY',          -- VNPay
  'ZALO_PAY',       -- ZaloPay
  'OTHER'           -- Khác
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,

  -- Payment info
  receipt_number TEXT, -- Số phiếu thu
  amount DECIMAL(15, 2) NOT NULL,
  payment_method payment_method NOT NULL DEFAULT 'CASH',
  payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT, -- Ảnh chụp biên lai

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT payments_amount_positive CHECK (amount > 0)
);

-- Indexes
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX idx_payments_payment_date ON payments(payment_date);
CREATE INDEX idx_payments_payment_method ON payments(payment_method);

-- RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments"
  ON payments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own payments"
  ON payments FOR ALL
  USING (auth.uid() = user_id);
```

---

### 12. METER_READINGS (Chỉ số công tơ)

```sql
CREATE TYPE meter_type AS ENUM ('ELECTRICITY', 'WATER', 'GAS', 'OTHER');

CREATE TABLE meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  -- Reading info
  meter_type meter_type NOT NULL,
  reading_date DATE NOT NULL,
  previous_reading DECIMAL(10, 2) NOT NULL DEFAULT 0,
  current_reading DECIMAL(10, 2) NOT NULL,
  consumption DECIMAL(10, 2) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,

  -- Metadata
  notes TEXT,
  meter_image_url TEXT, -- Ảnh chụp đồng hồ

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT meter_readings_current_gte_previous CHECK (current_reading >= previous_reading)
);

-- Indexes
CREATE INDEX idx_meter_readings_user_id ON meter_readings(user_id);
CREATE INDEX idx_meter_readings_contract_id ON meter_readings(contract_id);
CREATE INDEX idx_meter_readings_service_id ON meter_readings(service_id);
CREATE INDEX idx_meter_readings_reading_date ON meter_readings(reading_date);
CREATE INDEX idx_meter_readings_meter_type ON meter_readings(meter_type);

-- RLS
ALTER TABLE meter_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own meter readings"
  ON meter_readings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own meter readings"
  ON meter_readings FOR ALL
  USING (auth.uid() = user_id);
```

---

### 13. DEPOSITS (Đặt cọc)

```sql
CREATE TYPE deposit_status AS ENUM (
  'PENDING',      -- Chờ xác nhận
  'CONFIRMED',    -- Đã xác nhận
  'CONVERTED',    -- Đã chuyển thành hợp đồng
  'REFUNDED',     -- Đã hoàn lại
  'FORFEITED'     -- Bị mất cọc
);

CREATE TABLE deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id UUID REFERENCES beds(id) ON DELETE RESTRICT,
  contract_id UUID REFERENCES contracts(id), -- NULL khi chưa ký HĐ

  -- Deposit info
  amount DECIMAL(15, 2) NOT NULL,
  deposit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status deposit_status NOT NULL DEFAULT 'PENDING',

  -- Hold period
  hold_until DATE, -- Giữ phòng đến ngày

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT deposits_amount_positive CHECK (amount > 0)
);

-- Indexes
CREATE INDEX idx_deposits_user_id ON deposits(user_id);
CREATE INDEX idx_deposits_tenant_id ON deposits(tenant_id);
CREATE INDEX idx_deposits_room_id ON deposits(room_id);
CREATE INDEX idx_deposits_bed_id ON deposits(bed_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_deposits_deposit_date ON deposits(deposit_date);

-- RLS
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own deposits"
  ON deposits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own deposits"
  ON deposits FOR ALL
  USING (auth.uid() = user_id);
```

---

### 14. EXPENSES (Chi phí)

```sql
CREATE TYPE expense_category AS ENUM (
  'MAINTENANCE',    -- Bảo trì
  'REPAIR',         -- Sửa chữa
  'UTILITIES',      -- Tiện ích
  'SALARY',         -- Lương
  'SUPPLIES',       -- Vật tư
  'OTHER'           -- Khác
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Expense info
  category expense_category NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Links (optional)
  building_id UUID REFERENCES buildings(id) ON DELETE SET NULL,
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,

  -- Metadata
  notes TEXT,
  receipt_image_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT expenses_amount_positive CHECK (amount > 0)
);

-- Indexes
CREATE INDEX idx_expenses_user_id ON expenses(user_id);
CREATE INDEX idx_expenses_category ON expenses(category);
CREATE INDEX idx_expenses_expense_date ON expenses(expense_date);
CREATE INDEX idx_expenses_building_id ON expenses(building_id);
CREATE INDEX idx_expenses_deleted_at ON expenses(deleted_at);

-- RLS
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own expenses"
  ON expenses FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can manage own expenses"
  ON expenses FOR ALL
  USING (auth.uid() = user_id);
```

---

### 15. SETTINGS (Cài đặt hệ thống)

```sql
CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Setting key-value
  key TEXT NOT NULL,
  value JSONB NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, key)
);

-- Common settings:
-- - invoice_due_days: Số ngày hạn thanh toán
-- - invoice_number_format: Format số hóa đơn
-- - contract_number_format: Format số hợp đồng
-- - email_notifications: Bật/tắt email
-- - sms_notifications: Bật/tắt SMS

-- RLS
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own settings"
  ON settings FOR ALL
  USING (auth.uid() = user_id);
```

---

### 16. SIGNATURE_TEMPLATES (Mẫu chữ ký điện tử)

Lưu trữ các mẫu chữ ký để sử dụng trong hợp đồng, biên bản, phiếu thu.

```sql
CREATE TABLE signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  code TEXT NOT NULL, -- CK01, CK02, ... (auto-generated)
  name TEXT NOT NULL, -- "Chữ ký Giám đốc", "Chữ ký Kế toán"

  -- Signature data
  signature_type TEXT NOT NULL CHECK (signature_type IN ('UPLOAD', 'DRAW', 'TEXT')),
  signature_url TEXT, -- URL to uploaded/generated image in Supabase Storage
  signature_data JSONB, -- Raw canvas data for DRAW type (base64, strokes, etc.)
  text_content TEXT, -- Text for TEXT type
  font_style TEXT, -- Font for TEXT type (Dancing Script, Pacifico, etc.)

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, code),
  CONSTRAINT signature_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT signature_code_not_empty CHECK (char_length(code) > 0)
);

-- Indexes
CREATE INDEX idx_signature_templates_user_id ON signature_templates(user_id);
CREATE INDEX idx_signature_templates_code ON signature_templates(code);
CREATE INDEX idx_signature_templates_is_active ON signature_templates(is_active);

-- RLS
ALTER TABLE signature_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own signature templates"
  ON signature_templates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own signature templates"
  ON signature_templates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own signature templates"
  ON signature_templates FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own signature templates"
  ON signature_templates FOR DELETE
  USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER set_signature_templates_updated_at
  BEFORE UPDATE ON signature_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

**Sử dụng trong template**:
```sql
-- Example: Get signature URL for template rendering
SELECT signature_url
FROM signature_templates
WHERE user_id = auth.uid()
  AND code = 'CK01'
  AND is_active = true;
```

---

## 🔒 ROW LEVEL SECURITY (RLS)

### Nguyên tắc RLS

1. **User Isolation**: Mỗi user chỉ thấy dữ liệu của mình
2. **Cascade Authorization**: Check quyền theo cây phân cấp
3. **Soft Delete Aware**: Không hiển thị dữ liệu đã xóa mềm

### Template RLS Policy

```sql
-- SELECT policy
CREATE POLICY "policy_name"
  ON table_name FOR SELECT
  USING (
    auth.uid() = user_id
    AND deleted_at IS NULL
  );

-- INSERT policy
CREATE POLICY "policy_name"
  ON table_name FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- UPDATE policy
CREATE POLICY "policy_name"
  ON table_name FOR UPDATE
  USING (auth.uid() = user_id);

-- DELETE policy
CREATE POLICY "policy_name"
  ON table_name FOR DELETE
  USING (auth.uid() = user_id);

-- ALL policy (shorthand)
CREATE POLICY "policy_name"
  ON table_name FOR ALL
  USING (auth.uid() = user_id);
```

---

## 📈 INDEXES & PERFORMANCE

### Indexes đã tạo

Tất cả các indexes quan trọng đã được định nghĩa trong phần chi tiết bảng, bao gồm:

1. **Foreign key indexes**: Tất cả FK đều có index
2. **Status indexes**: Các cột status thường xuyên filter
3. **Date indexes**: Các cột ngày tháng cho range queries
4. **Unique indexes**: Đảm bảo tính duy nhất
5. **Full-text search**: GIN index cho tìm kiếm text

### Performance Tips

```sql
-- 1. Sử dụng EXPLAIN ANALYZE để check query performance
EXPLAIN ANALYZE
SELECT * FROM rooms WHERE building_id = 'xxx' AND status = 'AVAILABLE';

-- 2. Monitor slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY total_time DESC
LIMIT 10;

-- 3. Vacuum regularly (Supabase tự động)
VACUUM ANALYZE;
```

---

## ⚙️ TRIGGERS & FUNCTIONS

### 1. Auto update `updated_at`

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables
CREATE TRIGGER update_buildings_updated_at BEFORE UPDATE ON buildings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rooms_updated_at BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ... (apply to all tables with updated_at)
```

### 2. Auto calculate total_rooms in buildings

```sql
CREATE OR REPLACE FUNCTION update_building_total_rooms()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE buildings
  SET total_rooms = (
    SELECT COUNT(*)
    FROM rooms
    WHERE building_id = COALESCE(NEW.building_id, OLD.building_id)
      AND deleted_at IS NULL
  )
  WHERE id = COALESCE(NEW.building_id, OLD.building_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_building_total_rooms_on_room_change
  AFTER INSERT OR UPDATE OR DELETE ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION update_building_total_rooms();
```

### 3. Auto update room/bed status based on contracts

```sql
CREATE OR REPLACE FUNCTION update_asset_status_on_contract_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Update room status
  IF NEW.room_id IS NOT NULL THEN
    UPDATE rooms
    SET status = CASE
      WHEN NEW.status = 'ACTIVE' THEN 'OCCUPIED'::room_status
      WHEN NEW.status = 'TERMINATED' THEN 'AVAILABLE'::room_status
      ELSE status
    END
    WHERE id = NEW.room_id;
  END IF;

  -- Update bed status
  IF NEW.bed_id IS NOT NULL THEN
    UPDATE beds
    SET status = CASE
      WHEN NEW.status = 'ACTIVE' THEN 'OCCUPIED'::bed_status
      WHEN NEW.status = 'TERMINATED' THEN 'AVAILABLE'::bed_status
      ELSE status
    END
    WHERE id = NEW.bed_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_asset_status_on_contract_change_trigger
  AFTER INSERT OR UPDATE OF status ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_asset_status_on_contract_change();
```

### 4. Auto generate invoice/contract numbers

```sql
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT;
  counter INTEGER;
  new_number TEXT;
BEGIN
  IF NEW.invoice_number IS NULL THEN
    -- Get user's invoice prefix from settings (default: 'INV')
    SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

    -- Get next counter
    SELECT COUNT(*) + 1
    INTO counter
    FROM invoices
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    -- Generate: INV-2024-00001
    new_number := prefix || '-' ||
                  TO_CHAR(NOW(), 'YYYY') || '-' ||
                  LPAD(counter::TEXT, 5, '0');

    NEW.invoice_number := new_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_invoice_number_trigger
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION generate_invoice_number();
```

### 5. Auto update invoice paid_amount from payments

```sql
CREATE OR REPLACE FUNCTION update_invoice_paid_amount()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE invoices
  SET paid_amount = (
    SELECT COALESCE(SUM(amount), 0)
    FROM payments
    WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id)
  ),
  status = CASE
    WHEN (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id)) >= total_amount
      THEN 'PAID'::invoice_status
    WHEN (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id)) > 0
      THEN 'PARTIAL_PAID'::invoice_status
    ELSE status
  END
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_invoice_paid_amount_trigger
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION update_invoice_paid_amount();
```

### 6. Create profile on user signup

```sql
CREATE OR REPLACE FUNCTION create_profile_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, email, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    NEW.phone
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_profile_for_new_user();
```

---

## 📝 SQL MIGRATION SCRIPTS

### Cách chạy migrations trên Supabase

1. Vào **SQL Editor** trong Supabase Dashboard
2. Copy paste từng migration script
3. Chạy từ trên xuống theo thứ tự

### Migration 001: Create Enums & Extensions

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create enums
CREATE TYPE building_status AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
CREATE TYPE building_type AS ENUM ('APARTMENT', 'DORMITORY', 'HOUSE', 'OFFICE', 'SLEEPBOX', 'HOMESTAY');
CREATE TYPE room_status AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'MAINTENANCE', 'UNAVAILABLE');
CREATE TYPE bed_status AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'MAINTENANCE', 'UNAVAILABLE');
CREATE TYPE service_type AS ENUM ('FIXED', 'PER_PERSON', 'PER_ROOM', 'METER_READING');
CREATE TYPE tenant_status AS ENUM ('PROSPECT', 'DEPOSITED', 'ACTIVE', 'INACTIVE', 'BLACKLIST');
CREATE TYPE id_type AS ENUM ('CCCD', 'CMND', 'PASSPORT', 'OTHER');
CREATE TYPE contract_status AS ENUM ('DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED');
CREATE TYPE payment_cycle AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL');
CREATE TYPE invoice_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED');
CREATE TYPE invoice_item_type AS ENUM ('RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER');
CREATE TYPE payment_method AS ENUM ('CASH', 'BANK_TRANSFER', 'MOMO', 'VNPAY', 'ZALO_PAY', 'OTHER');
CREATE TYPE meter_type AS ENUM ('ELECTRICITY', 'WATER', 'GAS', 'OTHER');
CREATE TYPE deposit_status AS ENUM ('PENDING', 'CONFIRMED', 'CONVERTED', 'REFUNDED', 'FORFEITED');
CREATE TYPE expense_category AS ENUM ('MAINTENANCE', 'REPAIR', 'UTILITIES', 'SALARY', 'SUPPLIES', 'OTHER');
```

### Migration 002: Create Tables

Tạo các bảng theo thứ tự dependency:

```sql
-- 1. profiles
-- 2. buildings
-- 3. rooms
-- 4. beds
-- 5. services
-- 6. tenants
-- 7. contracts
-- 8. contract_services
-- 9. invoices
-- 10. invoice_items
-- 11. payments
-- 12. meter_readings
-- 13. deposits
-- 14. expenses
-- 15. settings
```

(Copy từ phần "Chi tiết các bảng" ở trên)

### Migration 003: Create Functions & Triggers

(Copy từ phần "Triggers & Functions" ở trên)

### Migration 004: Insert default data

```sql
-- Insert default services (for each user after they sign up)
-- This can be done via application code instead

-- Example:
-- INSERT INTO services (user_id, name, type, unit_price, unit)
-- VALUES
--   (auth.uid(), 'Tiền phòng', 'FIXED', 0, 'tháng'),
--   (auth.uid(), 'Điện', 'METER_READING', 3500, 'kWh'),
--   (auth.uid(), 'Nước', 'METER_READING', 15000, 'm3');
```

---

## 🔧 TYPESCRIPT TYPES

### Generate types from Supabase

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Link to your project
supabase link --project-ref your-project-ref

# Generate types
supabase gen types typescript --linked > src/types/database.ts
```

### Manual Type Definitions (src/types/models.ts)

```typescript
// Building
export interface Building {
  id: string;
  user_id: string;
  name: string;
  code?: string;
  type: 'APARTMENT' | 'DORMITORY' | 'HOUSE' | 'OFFICE' | 'SLEEPBOX' | 'HOMESTAY';
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
  province: string;
  district: string;
  ward: string;
  street_address?: string;
  total_floors: number;
  total_rooms: number;
  description?: string;
  images: string[];
  amenities: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

// Room
export interface Room {
  id: string;
  building_id: string;
  name: string;
  code?: string;
  floor: number;
  status: 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'MAINTENANCE' | 'UNAVAILABLE';
  area?: number;
  max_occupants: number;
  rent_price: number;
  deposit_amount: number;
  description?: string;
  images: string[];
  amenities: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

// ... (similar for other tables)
```

---

## 📚 NEXT STEPS

1. ✅ Read this schema document
2. 📄 Continue to [02-AUTH-FLOW.md](./02-AUTH-FLOW.md) - Implement authentication
3. 📄 [03-ASSET-MANAGEMENT.md](./03-ASSET-MANAGEMENT.md) - Implement asset management
4. 📄 [05-LEASING-FLOW.md](./05-LEASING-FLOW.md) - Implement contract management
5. 📄 [06-BILLING-FLOW.md](./06-BILLING-FLOW.md) - Implement billing

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [00-OVERVIEW.md](./00-OVERVIEW.md) | **Next**: [02-AUTH-FLOW.md](./02-AUTH-FLOW.md)
