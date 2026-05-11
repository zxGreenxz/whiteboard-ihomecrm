-- =============================================
-- Open RLS access for income_expense_types
-- Boss yêu cầu mở quyền không giới hạn: mọi authenticated user đều được
-- xem / tạo / sửa / xoá hạng mục thu chi (đây là dictionary table dùng
-- chung trong hệ thống, không có dữ liệu nhạy cảm).
-- =============================================

DROP POLICY IF EXISTS income_expense_types_select          ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_select_staff    ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_insert          ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_staff_insert    ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_update          ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_staff_update    ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_delete          ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_staff_delete    ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_admin_all       ON public.income_expense_types;
DROP POLICY IF EXISTS income_expense_types_super_admin_all ON public.income_expense_types;

CREATE POLICY income_expense_types_authenticated_all
  ON public.income_expense_types
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
