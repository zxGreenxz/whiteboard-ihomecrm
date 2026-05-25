-- =============================================
-- Migration: thêm sổ quỹ mặc định TT/TK cho từng tòa nhà
-- Created: 2026-05-25
-- Description:
--   Mỗi toà nhà có thể chỉ định 1 sổ quỹ mặc định nhận tiền khi khách thanh
--   toán hoá đơn phòng bằng phương thức TT (thanh toán/POS) và TK (chuyển
--   khoản). Áp dụng cho TẤT CẢ user — khác với TM (mỗi nhân viên dùng "sổ
--   Thu" riêng của họ). NULL = chưa chọn → FE fallback match-by-name (logic cũ).
-- =============================================

BEGIN;

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS default_account_id_tt UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_account_id_tk UUID NULL REFERENCES accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN buildings.default_account_id_tt IS
  'Sổ quỹ mặc định khi khách thanh toán hoá đơn phòng bằng TT (Thanh toán/POS) cho toà nhà này — áp dụng cho mọi user.';
COMMENT ON COLUMN buildings.default_account_id_tk IS
  'Sổ quỹ mặc định khi khách thanh toán hoá đơn phòng bằng TK (Chuyển khoản) cho toà nhà này — áp dụng cho mọi user.';

NOTIFY pgrst, 'reload schema';
COMMIT;
