-- =============================================
-- Migration 016: Customers Table
-- Created: 2025-11-21
-- Description: Create customers table with comprehensive customer information
-- =============================================

-- =============================================
-- 1. ENUMS
-- =============================================

-- Customer type enum
CREATE TYPE customer_type AS ENUM (
  'INDIVIDUAL',    -- Cá nhân
  'ORGANIZATION'   -- Tổ chức
);

-- Customer status enum
CREATE TYPE customer_status AS ENUM (
  'PROSPECT',      -- Khách tiềm năng
  'ACTIVE',        -- Khách hàng hiện tại
  'INACTIVE',      -- Không hoạt động
  'BLACKLIST'      -- Danh sách đen
);

-- =============================================
-- 2. CUSTOMERS TABLE
-- =============================================

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Customer type
  customer_type customer_type DEFAULT 'INDIVIDUAL',

  -- Personal/Organization info
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  date_of_birth DATE,
  gender TEXT,

  -- ID information
  id_type id_type DEFAULT 'CCCD',
  id_number TEXT,
  id_issue_date DATE,
  id_issue_place TEXT,

  -- Address information
  province TEXT,           -- Tỉnh/Thành phố
  district TEXT,           -- Quận/Huyện
  ward TEXT,              -- Xã/Phường
  detailed_address TEXT,  -- Địa chỉ chi tiết
  current_residence TEXT, -- Chỗ ở hiện tại
  permanent_address TEXT, -- Địa chỉ thường trú

  -- Bank information
  bank_account_number TEXT,
  bank_name TEXT,

  -- Employment information
  occupation TEXT,         -- Nghề nghiệp
  workplace TEXT,         -- Nơi làm việc

  -- Contact persons
  contact_person TEXT,            -- Người liên lạc
  contact_person_phone TEXT,      -- SĐT người liên lạc
  advisor TEXT,                   -- Người tư vấn
  advisor_phone TEXT,             -- SĐT người tư vấn

  -- Emergency contact
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relationship TEXT,

  -- Additional information
  fingerprint_code TEXT,          -- Mã vãn tay của ra vào
  customer_group TEXT,            -- Nhóm khách hàng
  is_foreign BOOLEAN DEFAULT false, -- Khách nước ngoài

  -- Status
  status customer_status DEFAULT 'PROSPECT',

  -- Metadata
  notes TEXT,
  avatar_url TEXT,
  id_images JSONB DEFAULT '[]'::jsonb, -- Front/back/passport images
  vehicles JSONB DEFAULT '[]'::jsonb,  -- Vehicle information

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT customers_full_name_not_empty CHECK (char_length(full_name) > 0),
  CONSTRAINT customers_phone_format CHECK (phone ~ '^[0-9]{10,11}$')
);

-- =============================================
-- 3. INDEXES
-- =============================================

CREATE INDEX idx_customers_user_id ON customers(user_id);
CREATE INDEX idx_customers_status ON customers(status);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_id_number ON customers(id_number);
CREATE INDEX idx_customers_customer_type ON customers(customer_type);
CREATE INDEX idx_customers_customer_group ON customers(customer_group);
CREATE INDEX idx_customers_deleted_at ON customers(deleted_at);

-- Full-text search
CREATE INDEX idx_customers_search ON customers USING GIN (
  to_tsvector('simple',
    coalesce(full_name, '') || ' ' ||
    coalesce(phone, '') || ' ' ||
    coalesce(email, '') || ' ' ||
    coalesce(id_number, '') || ' ' ||
    coalesce(occupation, '') || ' ' ||
    coalesce(workplace, '')
  )
);

-- =============================================
-- 4. RLS POLICIES
-- =============================================

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own customers"
  ON customers FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own customers"
  ON customers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own customers"
  ON customers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own customers"
  ON customers FOR DELETE
  USING (auth.uid() = user_id);

-- =============================================
-- 5. TRIGGERS
-- =============================================

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- 6. COMMENTS
-- =============================================

COMMENT ON TABLE customers IS 'Customer information and management';
COMMENT ON COLUMN customers.customer_type IS 'Type of customer: Individual or Organization';
COMMENT ON COLUMN customers.fingerprint_code IS 'Fingerprint access code';
COMMENT ON COLUMN customers.customer_group IS 'Customer group/category';
COMMENT ON COLUMN customers.is_foreign IS 'Whether customer is foreign/international';
COMMENT ON COLUMN customers.vehicles IS 'Array of vehicle information (JSON)';
