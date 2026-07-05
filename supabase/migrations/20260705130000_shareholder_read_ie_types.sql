-- Cho vai CỔ ĐÔNG đọc được các LOẠI thu/chi KHÔNG hạn chế.
--
-- Bối cảnh: cổ đông thuần (current_shareholder_id() NOT NULL) chỉ có quyền
-- shareholder_profit.view nên KHÔNG khớp income_expense_types_select_rbac
-- (can_access_org_entity('categories','view')) → bị chặn TOÀN BỘ bảng loại.
-- Hệ quả: báo cáo Lợi Nhuận (useAccrualReport) embed income_expense_type trả NULL,
-- mỗi dòng chi về client mất `category` → hạng mục cố định "Vệ sinh tòa nhà định kỳ"
-- (khớp theo category) và "Nước" (cần category để tách khỏi Điện) bị đánh dấu sai
-- "(chưa có phiếu)" dù phiếu có thật.
--
-- Policy PERMISSIVE này OR-merge với _rbac, CHỈ mở cho cổ đông và CHỈ loại
-- is_restricted=false. Loại hạn chế vẫn bị chặn (điều kiện is_restricted=false ở đây +
-- policy RESTRICTIVE income_expense_types_restricted_select giữ nguyên rào).
-- (SELECT current_shareholder_id()) bọc trong subselect theo convention initplan.

DROP POLICY IF EXISTS income_expense_types_select_shareholder ON public.income_expense_types;

CREATE POLICY income_expense_types_select_shareholder
  ON public.income_expense_types
  FOR SELECT
  TO authenticated
  USING (
    is_restricted = false
    AND (SELECT public.current_shareholder_id()) IS NOT NULL
  );
