-- =============================================
-- Phase 2.1-2.2: Additive RBAC policies cho invoices, payments, income_expenses
-- =============================================
-- ADDITIVE: thêm policy mới SONG SONG với policy cũ. PostgreSQL OR mọi policy match →
-- không ai mất access. Drop policy cũ ở phase riêng sau khi monitoring stable.
--
-- Policy mới dùng can_access_building / can_do_on_building (không phụ thuộc user_id).
-- Hệ quả ngay sau migration này:
--   - 9 invoice "lệch owner" (Hiệp/Joey tạo) → super_admin Tâm THẤY THÊM qua policy mới
--     (trước đây bị chặn vì invoices_select_own yêu cầu auth.uid()=user_id).
--   - User mới (Green) không có staff_assignments → can_access_building trả false →
--     không thấy gì, đúng kỳ vọng.
-- =============================================

-- ─── INVOICES ────────────────────────────────────────────────────────────────
CREATE POLICY invoices_select_rbac ON public.invoices
  FOR SELECT
  USING (public.can_access_building(building_id));

CREATE POLICY invoices_insert_rbac ON public.invoices
  FOR INSERT
  WITH CHECK (public.can_do_on_building('invoices','create',building_id));

CREATE POLICY invoices_update_rbac ON public.invoices
  FOR UPDATE
  USING (public.can_do_on_building('invoices','edit',building_id))
  WITH CHECK (public.can_do_on_building('invoices','edit',building_id));

CREATE POLICY invoices_delete_rbac ON public.invoices
  FOR DELETE
  USING (public.can_do_on_building('invoices','delete',building_id));

-- ─── INVOICE_ITEMS ───────────────────────────────────────────────────────────
-- invoice_items không có cột building_id, traverse qua invoice_id.
CREATE POLICY invoice_items_select_rbac ON public.invoice_items
  FOR SELECT
  USING (public.can_access_building(public.building_of_invoice(invoice_id)));

CREATE POLICY invoice_items_insert_rbac ON public.invoice_items
  FOR INSERT
  WITH CHECK (public.can_do_on_building('invoices','create', public.building_of_invoice(invoice_id)));

CREATE POLICY invoice_items_update_rbac ON public.invoice_items
  FOR UPDATE
  USING (public.can_do_on_building('invoices','edit', public.building_of_invoice(invoice_id)))
  WITH CHECK (public.can_do_on_building('invoices','edit', public.building_of_invoice(invoice_id)));

CREATE POLICY invoice_items_delete_rbac ON public.invoice_items
  FOR DELETE
  USING (public.can_do_on_building('invoices','delete', public.building_of_invoice(invoice_id)));

-- ─── PAYMENTS ────────────────────────────────────────────────────────────────
-- payments không có cột building_id, traverse qua invoice_id.
-- Dùng inline subquery vì building_of_payment chỉ work với p.id đã tồn tại (INSERT chưa có id).
CREATE POLICY payments_select_rbac ON public.payments
  FOR SELECT
  USING (public.can_access_building(
    (SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)
  ));

CREATE POLICY payments_insert_rbac ON public.payments
  FOR INSERT
  WITH CHECK (public.can_do_on_building('invoices','create',
    (SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)
  ));

CREATE POLICY payments_update_rbac ON public.payments
  FOR UPDATE
  USING (public.can_do_on_building('invoices','edit',
    (SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)
  ))
  WITH CHECK (public.can_do_on_building('invoices','edit',
    (SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)
  ));

CREATE POLICY payments_delete_rbac ON public.payments
  FOR DELETE
  USING (public.can_do_on_building('invoices','delete',
    (SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)
  ));

-- ─── INCOME_EXPENSES ─────────────────────────────────────────────────────────
-- income_expenses có sẵn cột building_id nhưng có thể NULL (voucher tổng quát không gắn toà).
-- Quy ước: building_id IS NULL → coi như voucher hệ thống, chỉ super_admin/admin truy cập.
CREATE POLICY income_expenses_select_rbac ON public.income_expenses
  FOR SELECT
  USING (
    public.is_super_admin()
    OR public.is_admin()
    OR (building_id IS NOT NULL AND public.can_access_building(building_id))
  );

CREATE POLICY income_expenses_insert_rbac ON public.income_expenses
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','create',building_id))
  );

CREATE POLICY income_expenses_update_rbac ON public.income_expenses
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit',building_id))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit',building_id))
  );

CREATE POLICY income_expenses_delete_rbac ON public.income_expenses
  FOR DELETE
  USING (
    public.is_super_admin()
    OR (building_id IS NOT NULL AND public.can_do_on_building('income_expenses','delete',building_id))
  );

-- ─── INCOME_EXPENSE_ITEMS ────────────────────────────────────────────────────
-- Traverse qua parent income_expense.
CREATE POLICY income_expense_items_select_rbac ON public.income_expense_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_items.income_expense_id
        AND (
          public.is_super_admin()
          OR public.is_admin()
          OR (ie.building_id IS NOT NULL AND public.can_access_building(ie.building_id))
        )
    )
  );

CREATE POLICY income_expense_items_insert_rbac ON public.income_expense_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_items.income_expense_id
        AND (
          public.is_super_admin()
          OR (ie.building_id IS NOT NULL AND public.can_do_on_building('income_expenses','create',ie.building_id))
        )
    )
  );

CREATE POLICY income_expense_items_update_rbac ON public.income_expense_items
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_items.income_expense_id
        AND (public.is_super_admin() OR (ie.building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit',ie.building_id)))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_items.income_expense_id
        AND (public.is_super_admin() OR (ie.building_id IS NOT NULL AND public.can_do_on_building('income_expenses','edit',ie.building_id)))
    )
  );

CREATE POLICY income_expense_items_delete_rbac ON public.income_expense_items
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_items.income_expense_id
        AND (public.is_super_admin() OR (ie.building_id IS NOT NULL AND public.can_do_on_building('income_expenses','delete',ie.building_id)))
    )
  );

-- ─── EXCESS_AMOUNTS ──────────────────────────────────────────────────────────
-- excess_amounts gắn với contract_id; traverse qua contract → room → building.
CREATE POLICY excess_amounts_select_rbac ON public.excess_amounts
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY excess_amounts_insert_rbac ON public.excess_amounts
  FOR INSERT
  WITH CHECK (public.can_do_on_building('invoices','create', public.building_of_contract(contract_id)));

CREATE POLICY excess_amounts_update_rbac ON public.excess_amounts
  FOR UPDATE
  USING (public.can_do_on_building('invoices','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('invoices','edit', public.building_of_contract(contract_id)));

CREATE POLICY excess_amounts_delete_rbac ON public.excess_amounts
  FOR DELETE
  USING (public.can_do_on_building('invoices','delete', public.building_of_contract(contract_id)));
