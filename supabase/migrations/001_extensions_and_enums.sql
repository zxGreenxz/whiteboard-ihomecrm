-- =============================================
-- Migration 001: Extensions & Enums
-- Created: 2025-11-18
-- Description: Setup database extensions and create all enum types
-- =============================================

-- Enable required extensions
-- =============================================

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Full-text search support
CREATE EXTENSION IF NOT EXISTS "pg_trgm";


-- Create all ENUM types
-- =============================================

-- Building related enums
-- =============================================

CREATE TYPE building_status AS ENUM (
  'ACTIVE',       -- Hoạt động
  'INACTIVE',     -- Ngừng hoạt động
  'MAINTENANCE'   -- Đang bảo trì
);

CREATE TYPE building_type AS ENUM (
  'APARTMENT',    -- Chung cư
  'DORMITORY',    -- Ký túc xá
  'HOUSE',        -- Nhà riêng
  'OFFICE',       -- Văn phòng
  'SLEEPBOX',     -- Sleepbox
  'HOMESTAY'      -- Homestay
);


-- Room & Bed related enums
-- =============================================

CREATE TYPE room_status AS ENUM (
  'AVAILABLE',    -- Phòng trống
  'OCCUPIED',     -- Đang cho thuê
  'RESERVED',     -- Đã đặt cọc
  'MAINTENANCE',  -- Đang sửa chữa
  'UNAVAILABLE'   -- Không cho thuê
);

CREATE TYPE bed_status AS ENUM (
  'AVAILABLE',    -- Giường trống
  'OCCUPIED',     -- Đang cho thuê
  'RESERVED',     -- Đã đặt cọc
  'MAINTENANCE',  -- Đang sửa chữa
  'UNAVAILABLE'   -- Không cho thuê
);


-- Service related enums
-- =============================================

CREATE TYPE service_type AS ENUM (
  'FIXED',          -- Cố định (VD: Wifi 100k/tháng)
  'PER_PERSON',     -- Theo người (VD: Vệ sinh 50k/người)
  'PER_ROOM',       -- Theo phòng (VD: Wifi 100k/phòng)
  'METER_READING'   -- Theo chỉ số công tơ (VD: Điện, nước)
);

CREATE TYPE meter_type AS ENUM (
  'ELECTRICITY',  -- Điện
  'WATER',        -- Nước
  'GAS',          -- Gas
  'OTHER'         -- Khác
);


-- Tenant related enums
-- =============================================

CREATE TYPE tenant_status AS ENUM (
  'PROSPECT',     -- Khách tiềm năng
  'DEPOSITED',    -- Đã đặt cọc
  'ACTIVE',       -- Đang thuê
  'INACTIVE',     -- Đã chuyển đi
  'BLACKLIST'     -- Danh sách đen
);

CREATE TYPE id_type AS ENUM (
  'CCCD',         -- Căn cước công dân
  'CMND',         -- Chứng minh nhân dân
  'PASSPORT',     -- Hộ chiếu
  'OTHER'         -- Khác
);


-- Contract related enums
-- =============================================

CREATE TYPE contract_status AS ENUM (
  'DRAFT',        -- Nháp
  'ACTIVE',       -- Đang hiệu lực
  'EXTENDED',     -- Đã gia hạn (tạo HĐ mới)
  'TRANSFERRED',  -- Đã chuyển phòng/nhượng HĐ
  'TERMINATED',   -- Đã thanh lý
  'EXPIRED'       -- Hết hạn
);

CREATE TYPE payment_cycle AS ENUM (
  'MONTHLY',      -- Hàng tháng
  'QUARTERLY',    -- 3 tháng
  'SEMI_ANNUAL',  -- 6 tháng
  'ANNUAL'        -- 1 năm
);


-- Billing related enums
-- =============================================

CREATE TYPE invoice_status AS ENUM (
  'DRAFT',              -- Nháp (chưa duyệt)
  'PENDING_APPROVAL',   -- Chờ duyệt
  'APPROVED',           -- Đã duyệt (gửi cho khách)
  'PAID',               -- Đã thanh toán đủ
  'PARTIAL_PAID',       -- Thanh toán một phần
  'OVERDUE',            -- Quá hạn
  'CANCELLED'           -- Đã hủy
);

CREATE TYPE invoice_item_type AS ENUM (
  'RENT',           -- Tiền phòng
  'SERVICE',        -- Dịch vụ
  'PENALTY',        -- Phạt
  'DISCOUNT',       -- Giảm giá
  'OTHER'           -- Khác
);

CREATE TYPE payment_method AS ENUM (
  'CASH',           -- Tiền mặt
  'BANK_TRANSFER',  -- Chuyển khoản
  'MOMO',           -- Momo
  'VNPAY',          -- VNPay
  'ZALO_PAY',       -- ZaloPay
  'OTHER'           -- Khác
);


-- Deposit related enums
-- =============================================

CREATE TYPE deposit_status AS ENUM (
  'PENDING',      -- Chờ xác nhận
  'CONFIRMED',    -- Đã xác nhận
  'CONVERTED',    -- Đã chuyển thành hợp đồng
  'REFUNDED',     -- Đã hoàn lại
  'FORFEITED'     -- Bị mất cọc
);


-- Expense related enums
-- =============================================

CREATE TYPE expense_category AS ENUM (
  'MAINTENANCE',    -- Bảo trì
  'REPAIR',         -- Sửa chữa
  'UTILITIES',      -- Tiện ích
  'SALARY',         -- Lương
  'SUPPLIES',       -- Vật tư
  'OTHER'           -- Khác
);


-- Asset related enums
-- =============================================

CREATE TYPE asset_condition AS ENUM (
  'NEW',      -- Mới
  'GOOD',     -- Tốt
  'FAIR',     -- Khá
  'POOR',     -- Kém
  'BROKEN'    -- Hư hỏng
);

CREATE TYPE vehicle_type AS ENUM (
  'MOTORBIKE',  -- Xe máy
  'CAR',        -- Ô tô
  'BICYCLE',    -- Xe đạp
  'OTHER'       -- Khác
);


-- Issue/Task related enums
-- =============================================

CREATE TYPE issue_priority AS ENUM (
  'LOW',      -- Thấp
  'MEDIUM',   -- Trung bình
  'HIGH',     -- Cao
  'URGENT'    -- Khẩn cấp
);

CREATE TYPE issue_status AS ENUM (
  'NEW',          -- Mới
  'ASSIGNED',     -- Đã phân công
  'IN_PROGRESS',  -- Đang xử lý
  'RESOLVED',     -- Đã giải quyết
  'CLOSED',       -- Đã đóng
  'CANCELLED'     -- Đã hủy
);


-- Lead related enums
-- =============================================

CREATE TYPE lead_status AS ENUM (
  'B1_LEAD',          -- Bước 1: Bắn khách
  'B2_APPOINTMENT',   -- Bước 2: Hẹn khách
  'B3_CONSULTATION',  -- Bước 3: Tư vấn
  'CONVERTED',        -- Đã chuyển đổi (thành deposit/contract)
  'FAILED'            -- Thất bại
);

CREATE TYPE lead_source AS ENUM (
  'FACEBOOK',     -- Facebook
  'ZALO',         -- Zalo
  'PHONE',        -- Điện thoại
  'REFERRAL',     -- Giới thiệu
  'WALK_IN',      -- Khách vào trực tiếp
  'WEBSITE',      -- Website
  'OTHER'         -- Khác
);


-- Notification related enums
-- =============================================

CREATE TYPE notification_type AS ENUM (
  'NEW_INVOICE',          -- Hóa đơn mới
  'PAYMENT_REMINDER',     -- Nhắc thanh toán
  'OVERDUE_INVOICE',      -- Hóa đơn quá hạn
  'CONTRACT_EXPIRING',    -- Hợp đồng sắp hết hạn
  'ISSUE_RESOLVED',       -- Sự cố đã giải quyết
  'GENERAL_ANNOUNCEMENT', -- Thông báo chung
  'CUSTOM'                -- Tùy chỉnh
);

CREATE TYPE notification_channel AS ENUM (
  'IN_APP',   -- Trong app
  'EMAIL',    -- Email
  'SMS',      -- SMS
  'ZALO',     -- Zalo ZNS
  'PUSH'      -- Push notification
);

CREATE TYPE notification_status AS ENUM (
  'PENDING',    -- Chờ gửi
  'SENT',       -- Đã gửi
  'FAILED',     -- Thất bại
  'CANCELLED'   -- Đã hủy
);


-- Comment for tracking
-- =============================================
COMMENT ON EXTENSION "uuid-ossp" IS 'UUID generation support';
COMMENT ON EXTENSION "pg_trgm" IS 'Full-text search trigram support';

-- Migration completed
-- =============================================
-- Total: 2 extensions, 28 enum types created
-- Next: 002_core_tables_part1.sql
