-- =============================================
-- Migration: Tái cấu trúc logic Sổ quỹ
-- - Thêm cờ buildings.is_virtual + tạo "tòa ảo Chung" cho mỗi user
--   (để hạch toán chi phí không thuộc tòa thật nhưng vẫn giữ building_id NOT NULL)
-- - Thêm metadata tiền thối lên income_expenses (change_amount, change_account_id)
--   để mỗi phiếu thu HĐ có thể ghi nhận số tiền thối mà KHÔNG tạo phiếu chi
--   → sổ "X Thối" không bị âm số dư, vẫn dùng làm sổ log/audit.
-- =============================================

BEGIN;

-- 1) Cờ phân biệt "tòa ảo" (đại diện đối tượng hạch toán Chung)
ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS is_virtual BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_buildings_is_virtual
  ON buildings(user_id, is_virtual) WHERE is_virtual = true;

COMMENT ON COLUMN buildings.is_virtual IS
  'true = tòa ảo (vd "Chung") chỉ dùng để hạch toán chi phí không thuộc tòa thật. Phải ẩn khỏi các selector HĐ/phòng/contract.';

-- 2) Mỗi user có 1 tòa ảo tên "Chung" để hạch toán chi phí không thuộc tòa thật
INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)
SELECT DISTINCT
  u.id,
  'Chung',
  'APARTMENT'::building_type,
  'ACTIVE'::building_status,
  '—',
  '—',
  '—',
  true
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM buildings b
  WHERE b.user_id = u.id AND b.is_virtual = true AND b.name = 'Chung'
);

-- 3) Metadata tiền thối trên phiếu thu HĐ (KHÔNG ảnh hưởng số dư sổ)
ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(15, 2) NOT NULL DEFAULT 0;

ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS change_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_income_expenses_change_account
  ON income_expenses(change_account_id) WHERE change_account_id IS NOT NULL;

COMMENT ON COLUMN income_expenses.change_amount IS
  'Số tiền thối lại cho khách khi thu HĐ tiền mặt. Chỉ là metadata audit — KHÔNG đi vào balance.';
COMMENT ON COLUMN income_expenses.change_account_id IS
  'Sổ X Thối nhận log giao dịch thối. Sổ này không tham gia tính balance.';

COMMIT;
