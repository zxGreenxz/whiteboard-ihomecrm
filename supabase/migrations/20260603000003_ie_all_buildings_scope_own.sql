-- =============================================================
-- Thu hẹp quyền "Mọi toà nhà" (income_expenses.all_buildings) → CHỈ phiếu CỦA
-- CHÍNH MÌNH tạo, xuyên toà.
--
-- Vấn đề: migration 20260603000002 tạo policy all_buildings cho SELECT/INSERT/
-- UPDATE/DELETE chỉ kiểm building (ie_all_buildings_scope / can_ie_all_buildings),
-- KHÔNG kiểm user_id. Hệ quả: nhân viên được cấp quyền nhìn thấy + sửa được phiếu
-- thu chi do NGƯỜI KHÁC tạo ở toà họ không quản lý (vd kế toán thấy hết phiếu của
-- quản lý toà khác). Ngoài ý muốn.
--
-- Chủ ý đúng: "Mọi toà nhà" = được GHI thu chi cho mọi toà của chủ và tự xem/sửa
-- phiếu DO MÌNH tạo (đủ cho luồng tạo .insert().select() = RETURNING và sửa phiếu
-- mình). KHÔNG mở quyền xem/sửa phiếu của người khác. Phiếu ở toà mình QUẢN LÝ vẫn
-- thấy/sửa đầy đủ qua RBAC cũ (can_access_building / can_do_on_building) — không đổi.
--
-- (Lưu ý: việc chủ sổ quỹ thấy mọi giao dịch trên sổ của mình là policy RIÊNG
--  income_expenses_select_fund_member — có sẵn, cố ý, không đụng ở đây.)
--
-- Idempotent: DROP IF EXISTS + CREATE lại 8 policy với điều kiện user_id=auth.uid().
-- =============================================================

BEGIN;

-- ── income_expenses ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS income_expenses_select_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_select_all_buildings ON public.income_expenses
  FOR SELECT
  USING (
    building_id IS NOT NULL
    AND user_id = auth.uid()
    AND public.ie_all_buildings_scope(building_id)
  );

DROP POLICY IF EXISTS income_expenses_insert_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_insert_all_buildings ON public.income_expenses
  FOR INSERT
  WITH CHECK (
    building_id IS NOT NULL
    AND user_id = auth.uid()
    AND public.can_ie_all_buildings('create', building_id)
  );

DROP POLICY IF EXISTS income_expenses_update_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_update_all_buildings ON public.income_expenses
  FOR UPDATE
  USING (
    building_id IS NOT NULL
    AND user_id = auth.uid()
    AND public.can_ie_all_buildings('edit', building_id)
  )
  WITH CHECK (
    building_id IS NOT NULL
    AND user_id = auth.uid()
    AND public.can_ie_all_buildings('edit', building_id)
  );

DROP POLICY IF EXISTS income_expenses_delete_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_delete_all_buildings ON public.income_expenses
  FOR DELETE
  USING (
    building_id IS NOT NULL
    AND user_id = auth.uid()
    AND public.can_ie_all_buildings('delete', building_id)
  );

-- ── income_expense_items (traverse parent voucher, kèm ie.user_id = caller) ──
DROP POLICY IF EXISTS income_expense_items_select_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_select_all_buildings ON public.income_expense_items
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = auth.uid()
      AND public.ie_all_buildings_scope(ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_insert_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_insert_all_buildings ON public.income_expense_items
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = auth.uid()
      AND public.can_ie_all_buildings('create', ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_update_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_update_all_buildings ON public.income_expense_items
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = auth.uid()
      AND public.can_ie_all_buildings('edit', ie.building_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = auth.uid()
      AND public.can_ie_all_buildings('edit', ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_delete_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_delete_all_buildings ON public.income_expense_items
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = auth.uid()
      AND public.can_ie_all_buildings('delete', ie.building_id)
  ));

NOTIFY pgrst, 'reload schema';
COMMIT;
