-- =============================================================================
-- income_expenses: set-based nốt các policy SELECT permissive còn per-row
--
-- BỐI CẢNH: đợt 20260702150000 chỉ rewrite income_expenses_select_rbac.
-- Các policy permissive SELECT còn lại gọi helper THEO TỪNG DÒNG (correlated)
-- hoặc gọi trần không bọc (SELECT ...) nên planner không hoist được:
--   • fund_member: is_account_owner(×3) + is_account_shared_with_me(×3)
--     = tới 6 EXISTS/dòng quét accounts + account_shared_users.
--   • all_buildings: ie_all_buildings_scope(building_id) EXISTS/dòng trên
--     staff_assignments ⋈ roles ⋈ buildings.
--   • profit_manager / shareholder: current_*_id() gọi trần → chạy mỗi dòng.
--   • salary_staff: auth.uid() trần.
-- Baseline đo 03/07 (count(*) 1.552 dòng): owner 2ms, nathan ~113ms,
-- joey ~145ms, bosshuy ~100ms — thuế per-row rơi vào staff.
--
-- CÁCH SỬA: mẫu InitPlan/hashed-SubPlan đã chứng minh ở 20260702150000 —
-- helper set-returning dựng TẬP id MỘT LẦN/câu lệnh + bọc (SELECT fn()).
-- Ngữ nghĩa giữ nguyên (EXISTS theo id ≡ membership trong tập id; NULL
-- không match ở cả 2 dạng). Verify: snapshot.mjs 6 user so count+md5.
-- =============================================================================

-- ---------- Helper 1: tập account tôi sở hữu ∪ được chia sẻ ----------
-- (≡ is_account_owner(x) OR is_account_shared_with_me(x) cho mọi x trong tập)
CREATE OR REPLACE FUNCTION public.accessible_account_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.accounts WHERE user_id = auth.uid()
  UNION
  SELECT account_id FROM public.account_shared_users WHERE user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.accessible_account_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accessible_account_ids() TO authenticated;

-- ---------- Helper 2: tập tòa trong scope "thu chi mọi tòa nhà" ----------
-- (≡ ie_all_buildings_scope(b) cho mọi b trong tập — cùng JOIN/điều kiện,
--  chỉ bỏ lọc theo _building_id để trả cả tập)
CREATE OR REPLACE FUNCTION public.ie_all_buildings_ids()
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
    AND COALESCE(
          (COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'all_buildings')::boolean,
          false) = true;
$$;
REVOKE ALL ON FUNCTION public.ie_all_buildings_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_all_buildings_ids() TO authenticated;

-- ---------- Rewrite các policy SELECT ----------

-- 6 call correlated/dòng → 3 phép membership trên 1 tập dựng 1 lần
ALTER POLICY income_expenses_select_fund_member ON public.income_expenses
USING (
  deleted_at IS NULL
  AND (
       account_id          IN (SELECT public.accessible_account_ids())
    OR change_account_id   IN (SELECT public.accessible_account_ids())
    OR rounding_account_id IN (SELECT public.accessible_account_ids())
  )
);

-- EXISTS/dòng → membership tập tòa all_buildings (dựng 1 lần)
ALTER POLICY income_expenses_select_all_buildings ON public.income_expenses
USING (
  building_id IS NOT NULL
  AND user_id = (SELECT auth.uid())
  AND building_id IN (SELECT public.ie_all_buildings_ids())
);

-- gọi trần → bọc (SELECT ...) thành InitPlan
ALTER POLICY income_expenses_select_profit_manager ON public.income_expenses
USING (
  deleted_at IS NULL
  AND profit_manager_id = (SELECT public.current_profit_manager_id())
);

ALTER POLICY income_expenses_select_shareholder ON public.income_expenses
USING (
  deleted_at IS NULL
  AND shareholder_id = (SELECT public.current_shareholder_id())
);

ALTER POLICY income_expenses_select_salary_staff ON public.income_expenses
USING (
  deleted_at IS NULL
  AND salary_staff_id = (SELECT auth.uid())
);
