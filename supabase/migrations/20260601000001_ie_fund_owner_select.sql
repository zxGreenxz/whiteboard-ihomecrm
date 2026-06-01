-- Chủ sổ quỹ + người được chia sẻ sổ thấy MỌI giao dịch thuộc sổ,
-- không phụ thuộc quyền RBAC toà nhà (khớp số dư accounts_with_balance).
--
-- Bối cảnh: khi lên RBAC, policy "người tạo phiếu" (user_id = auth.uid()) đã bị
-- drop ở 20260528000003_rbac_batch_f_drop_legacy.sql, và chưa từng có policy
-- "chủ sổ". Hệ quả: chủ sổ quỹ không thấy chính phiếu của sổ mình nếu phiếu gắn
-- toà nhà ngoài phạm vi RBAC của họ (vd chi phí chung gắn "Kho Văn Phòng Chung").
-- Số dư (đọc qua view accounts_with_balance — bỏ qua RLS) vẫn cộng đủ → danh sách
-- "Xem thu chi" thiếu giao dịch so với số dư.
--
-- Cách xử lý: thêm 1 SELECT policy additive cho chủ sổ + người được chia sẻ, phủ
-- cả account_id / change_account_id / rounding_account_id (cho sổ "Thối"/"Làm tròn").
-- OR-merge với income_expenses_select_rbac + admin/super-admin sẵn có → chỉ NỚI thêm.

-- Gộp policy shared cũ (chỉ phủ account_id) vào policy đầy đủ bên dưới.
DROP POLICY IF EXISTS "income_expenses_select_shared" ON public.income_expenses;

CREATE POLICY "income_expenses_select_fund_member" ON public.income_expenses
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      public.is_account_owner(account_id)
      OR public.is_account_owner(change_account_id)
      OR public.is_account_owner(rounding_account_id)
      OR public.is_account_shared_with_me(account_id)
      OR public.is_account_shared_with_me(change_account_id)
      OR public.is_account_shared_with_me(rounding_account_id)
    )
  );
