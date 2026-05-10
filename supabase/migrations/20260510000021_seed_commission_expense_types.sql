-- =============================================
-- Migration: Seed 2 expense types for commission flow
-- - "Hoa hồng môi giới"   → cho Đơn vị MG
-- - "Thưởng nóng Sale"    → cho Sale (optional)
--
-- income_expense_types là per-user (RLS theo user_id), nên cần seed cho
-- mọi user hiện có + auto-seed cho user mới qua trigger on_auth_user_created.
-- =============================================

-- 1. Function tự seed 2 type cho 1 user (idempotent qua tên)
CREATE OR REPLACE FUNCTION seed_commission_expense_types(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO income_expense_types (user_id, name, type, description, is_default)
  SELECT p_user_id, 'Hoa hồng môi giới', 'expense',
         'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.', false
  WHERE NOT EXISTS (
    SELECT 1 FROM income_expense_types
    WHERE user_id = p_user_id
      AND lower(name) = lower('Hoa hồng môi giới')
      AND type = 'expense'
  );

  INSERT INTO income_expense_types (user_id, name, type, description, is_default)
  SELECT p_user_id, 'Thưởng nóng Sale', 'expense',
         'Thưởng cho Sale khi tạo hợp đồng — số tiền do user nhập tay.', false
  WHERE NOT EXISTS (
    SELECT 1 FROM income_expense_types
    WHERE user_id = p_user_id
      AND lower(name) = lower('Thưởng nóng Sale')
      AND type = 'expense'
  );
END;
$$;

-- 2. Seed cho mọi user hiện tại
DO $$
DECLARE
  u RECORD;
BEGIN
  FOR u IN SELECT id FROM auth.users LOOP
    PERFORM seed_commission_expense_types(u.id);
  END LOOP;
END $$;

-- 3. Trigger function: auto-seed khi user mới signup
CREATE OR REPLACE FUNCTION trg_seed_commission_types_on_user_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_commission_expense_types(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Không block tạo user nếu seed lỗi
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_seed_commission_types ON auth.users;
CREATE TRIGGER on_auth_user_created_seed_commission_types
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION trg_seed_commission_types_on_user_create();
