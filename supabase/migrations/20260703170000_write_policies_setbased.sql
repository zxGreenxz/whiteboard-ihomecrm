-- =============================================================================
-- Policy WRITE (INSERT/UPDATE/DELETE) set-based cho 4 bảng nóng:
-- invoices, payments, income_expenses, income_expense_items
--
-- VẤN ĐỀ: mọi write đi qua can_do_on_building(_table,_action,building_id) /
-- can_ie_all_buildings(_action,building_id) — helper CORRELATED chạy 1 lần/
-- DÒNG GHI (bulk thu tiền, batch sinh hoá đơn = N lần quét staff_assignments
-- ⋈ roles ⋈ area_buildings). Cùng bug class với đợt SELECT 20260702150000.
--
-- CÁCH SỬA: tách can_do_on_building(t,a,b) thành các phần không-tương-quan:
--   is_super_admin() OR is_admin()                → (SELECT ...)  InitPlan
--   EXISTS(gán FULL-SCOPE có quyền t.a)           → has_perm_full_scope(t,a)
--   b ∈ {tòa gán trực tiếp/theo khu có quyền t.a} → permitted_building_ids(t,a)
-- và can_ie_all_buildings(a,b) → b ∈ ie_all_buildings_action_ids(a).
-- Truth-table giữ nguyên từng nhánh (kể cả building_id NULL: membership
-- NULL IN (...) = NULL ≡ EXISTS(...b=NULL) = false).
--
-- Verify (scratchpad write-policy-equiv.mjs): chạy predicate CŨ vs MỚI như
-- bộ lọc SELECT trên TOÀN BỘ dòng hiện có (bypass RLS, set claims từng user)
-- × 6 user × 19 policy — phải khớp 100% count+md5 trước khi ALTER.
-- =============================================================================

-- ---------- Helpers (STABLE SECURITY DEFINER, revoke anon) ----------

-- TRUE nếu user có assignment FULL-SCOPE (building & area đều NULL) kèm quyền _table._action
CREATE OR REPLACE FUNCTION public.has_perm_full_scope(_table text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = auth.uid()
      AND sa.building_id IS NULL AND sa.area_id IS NULL
      AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  );
$$;
REVOKE ALL ON FUNCTION public.has_perm_full_scope(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_perm_full_scope(text, text) TO authenticated;

-- Tập tòa user có quyền _table._action qua gán tòa cụ thể HOẶC theo khu
CREATE OR REPLACE FUNCTION public.permitted_building_ids(_table text, _action text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT sa.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true
  UNION
  SELECT ab.building_id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.area_buildings ab ON ab.area_id = sa.area_id
  WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true;
$$;
REVOKE ALL ON FUNCTION public.permitted_building_ids(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.permitted_building_ids(text, text) TO authenticated;

-- Tập tòa trong scope "thu chi mọi tòa" KÈM quyền hành động cụ thể
-- (≡ can_ie_all_buildings(_action, b) cho mọi b trong tập)
CREATE OR REPLACE FUNCTION public.ie_all_buildings_action_ids(_action text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT b.id
  FROM public.staff_assignments sa
  LEFT JOIN public.roles r ON r.id = sa.role_id
  JOIN public.buildings b ON b.user_id = sa.user_id
  WHERE sa.staff_id = auth.uid()
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'all_buildings')::boolean, false) = true
    AND COALESCE((COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> _action)::boolean, false) = true;
$$;
REVOKE ALL ON FUNCTION public.ie_all_buildings_action_ids(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_all_buildings_action_ids(text) TO authenticated;

-- Tập sổ quỹ ĐƯỢC CHIA SẺ cho tôi (khác accessible_account_ids: không gồm sổ tôi sở hữu)
CREATE OR REPLACE FUNCTION public.shared_account_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id FROM public.account_shared_users WHERE user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.shared_account_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_account_ids() TO authenticated;

-- ---------- income_expenses ----------

ALTER POLICY income_expenses_delete_rbac ON public.income_expenses
USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND (
       (SELECT public.is_admin())
    OR (SELECT public.has_perm_full_scope('income_expenses','delete'))
    OR building_id IN (SELECT public.permitted_building_ids('income_expenses','delete'))
  ))
);

ALTER POLICY income_expenses_update_rbac ON public.income_expenses
USING (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND (
       (SELECT public.is_admin())
    OR (SELECT public.has_perm_full_scope('income_expenses','edit'))
    OR building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
  ))
)
WITH CHECK (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND (
       (SELECT public.is_admin())
    OR (SELECT public.has_perm_full_scope('income_expenses','edit'))
    OR building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
  ))
);

ALTER POLICY income_expenses_insert_rbac ON public.income_expenses
WITH CHECK (
  (SELECT public.is_super_admin())
  OR (building_id IS NOT NULL AND (
       (SELECT public.is_admin())
    OR (SELECT public.has_perm_full_scope('income_expenses','create'))
    OR building_id IN (SELECT public.permitted_building_ids('income_expenses','create'))
  ))
);

ALTER POLICY income_expenses_delete_all_buildings ON public.income_expenses
USING (
  building_id IS NOT NULL
  AND user_id = (SELECT auth.uid())
  AND building_id IN (SELECT public.ie_all_buildings_action_ids('delete'))
);

ALTER POLICY income_expenses_update_all_buildings ON public.income_expenses
USING (
  building_id IS NOT NULL
  AND user_id = (SELECT auth.uid())
  AND building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))
)
WITH CHECK (
  building_id IS NOT NULL
  AND user_id = (SELECT auth.uid())
  AND building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))
);

ALTER POLICY income_expenses_insert_all_buildings ON public.income_expenses
WITH CHECK (
  building_id IS NOT NULL
  AND user_id = (SELECT auth.uid())
  AND building_id IN (SELECT public.ie_all_buildings_action_ids('create'))
);

ALTER POLICY income_expenses_insert_shared ON public.income_expenses
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND account_id IN (SELECT public.shared_account_ids())
);

-- ---------- invoices ----------

ALTER POLICY invoices_delete_rbac ON public.invoices
USING (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','delete'))
  OR building_id IN (SELECT public.permitted_building_ids('invoices','delete'))
);

ALTER POLICY invoices_update_rbac ON public.invoices
USING (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','edit'))
  OR building_id IN (SELECT public.permitted_building_ids('invoices','edit'))
)
WITH CHECK (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','edit'))
  OR building_id IN (SELECT public.permitted_building_ids('invoices','edit'))
);

ALTER POLICY invoices_insert_rbac ON public.invoices
WITH CHECK (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','create'))
  OR building_id IN (SELECT public.permitted_building_ids('invoices','create'))
);

-- ---------- payments (building qua hoá đơn cha — giữ nguyên sub-select) ----------

ALTER POLICY payments_delete_rbac ON public.payments
USING (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','delete'))
  OR (SELECT i.building_id FROM public.invoices i WHERE i.id = payments.invoice_id)
       IN (SELECT public.permitted_building_ids('invoices','delete'))
);

ALTER POLICY payments_update_rbac ON public.payments
USING (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','edit'))
  OR (SELECT i.building_id FROM public.invoices i WHERE i.id = payments.invoice_id)
       IN (SELECT public.permitted_building_ids('invoices','edit'))
)
WITH CHECK (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','edit'))
  OR (SELECT i.building_id FROM public.invoices i WHERE i.id = payments.invoice_id)
       IN (SELECT public.permitted_building_ids('invoices','edit'))
);

ALTER POLICY payments_insert_rbac ON public.payments
WITH CHECK (
     (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (SELECT public.has_perm_full_scope('invoices','create'))
  OR (SELECT i.building_id FROM public.invoices i WHERE i.id = payments.invoice_id)
       IN (SELECT public.permitted_building_ids('invoices','create'))
);

-- ---------- income_expense_items (giữ EXISTS sang phiếu cha, đổi phần trong) ----------

ALTER POLICY income_expense_items_delete_rbac ON public.income_expense_items
USING (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ( (SELECT public.is_super_admin())
         OR (ie.building_id IS NOT NULL AND (
              (SELECT public.is_admin())
           OR (SELECT public.has_perm_full_scope('income_expenses','delete'))
           OR ie.building_id IN (SELECT public.permitted_building_ids('income_expenses','delete'))
         )) )
  )
);

ALTER POLICY income_expense_items_update_rbac ON public.income_expense_items
USING (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ( (SELECT public.is_super_admin())
         OR (ie.building_id IS NOT NULL AND (
              (SELECT public.is_admin())
           OR (SELECT public.has_perm_full_scope('income_expenses','edit'))
           OR ie.building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
         )) )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ( (SELECT public.is_super_admin())
         OR (ie.building_id IS NOT NULL AND (
              (SELECT public.is_admin())
           OR (SELECT public.has_perm_full_scope('income_expenses','edit'))
           OR ie.building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
         )) )
  )
);

ALTER POLICY income_expense_items_insert_rbac ON public.income_expense_items
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ( (SELECT public.is_super_admin())
         OR (ie.building_id IS NOT NULL AND (
              (SELECT public.is_admin())
           OR (SELECT public.has_perm_full_scope('income_expenses','create'))
           OR ie.building_id IN (SELECT public.permitted_building_ids('income_expenses','create'))
         )) )
  )
);

ALTER POLICY income_expense_items_delete_all_buildings ON public.income_expense_items
USING (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = (SELECT auth.uid())
      AND ie.building_id IN (SELECT public.ie_all_buildings_action_ids('delete'))
  )
);

ALTER POLICY income_expense_items_update_all_buildings ON public.income_expense_items
USING (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = (SELECT auth.uid())
      AND ie.building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = (SELECT auth.uid())
      AND ie.building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))
  )
);

ALTER POLICY income_expense_items_insert_all_buildings ON public.income_expense_items
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND ie.user_id = (SELECT auth.uid())
      AND ie.building_id IN (SELECT public.ie_all_buildings_action_ids('create'))
  )
);
