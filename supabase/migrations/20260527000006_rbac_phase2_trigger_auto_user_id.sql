-- =============================================
-- Phase 2.4: Trigger BEFORE INSERT auto-fill user_id = auth.uid() nếu NULL
-- =============================================
-- Mục tiêu: cho phép frontend BỎ truyền `user_id: user.id` trong INSERT.
-- DB sẽ tự fill `auth.uid()` để giữ thông tin audit (ai tạo row).
-- Phase 6 sẽ rename cột này thành `created_by` — đúng ngữ nghĩa audit.
--
-- ADDITIVE: nếu frontend vẫn truyền user_id thì trigger không động vào (chỉ fill khi NULL).
-- KHÔNG động dữ liệu hiện có.
-- =============================================

CREATE OR REPLACE FUNCTION public.set_user_id_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_user_id_from_auth() IS
  'BEFORE INSERT trigger: nếu NEW.user_id NULL thì gán auth.uid(). Dùng cho audit; không tham gia access control.';

-- Apply trigger cho các bảng tài chính của phase 2.
-- Trigger name pattern: <table>_set_user_id_audit.
CREATE TRIGGER invoices_set_user_id_audit
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER payments_set_user_id_audit
  BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER income_expenses_set_user_id_audit
  BEFORE INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

-- excess_amounts có cột user_id NOT NULL
CREATE TRIGGER excess_amounts_set_user_id_audit
  BEFORE INSERT ON public.excess_amounts
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
