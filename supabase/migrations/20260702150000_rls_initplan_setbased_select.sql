-- =====================================================================
-- RLS PERF: initplan wrap + set-based SELECT policies (đợt 2026-07-02)
--
-- Vấn đề (đo prod, tài khoản staff scoped NATHAN): mọi trang chậm 2–16s/request
-- vì policy gọi HÀM TỪNG DÒNG:
--   1) ~70 policy `<t>_admin_all` / `<t>_super_admin_all` gọi is_admin() /
--      is_super_admin() trần — Postgres KHÔNG hoist STABLE fn, chạy lại mỗi dòng.
--      Fix chuẩn Supabase (auth_rls_initplan): bọc `(SELECT fn())` → InitPlan
--      1 lần/statement. Ngữ nghĩa y hệt.
--   2) *_select_rbac của các bảng nóng gọi can_access_building(<cột dòng>)
--      per-row (mỗi lần = is_super + is_admin + 2 EXISTS). Fix: tách thành
--      has_full_building_scope() (uncorrelated → InitPlan) + <cột> IN
--      (SELECT accessible_building_ids()) (uncorrelated → Hashed SubPlan
--      build 1 lần). Đây là đúng phép tách v_priv/v_bids đã verify ở
--      get_invoice_statistics_v2 (20260630120000, 403ms→22ms).
--
-- can_access_building (bản hiện hành 20260701170000) ≡
--   has_full_building_scope() OR _building_id IN (SELECT accessible_building_ids())
-- (nhánh NULL: cả 2 vế chỉ pass qua priv/full-scope — giữ nguyên).
--
-- CHỈ sửa SELECT policy. KHÔNG đụng: policy insert/update/delete,
-- RESTRICTIVE restricted-categories (20260613000000), các policy self/share.
-- =====================================================================

BEGIN;

-- ── 1. Helpers (STABLE SECURITY DEFINER — bỏ qua RLS lồng nhau, mirror
--       ĐÚNG các nhánh của can_access_building 20260701170000, KHÔNG cổ đông) ──

-- v_priv: super admin / admin / staff full-scope (building_id NULL AND area_id NULL)
CREATE OR REPLACE FUNCTION public.has_full_building_scope()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin() OR public.is_admin() OR EXISTS (
    SELECT 1 FROM public.staff_assignments sa
    WHERE sa.staff_id = auth.uid()
      AND sa.building_id IS NULL AND sa.area_id IS NULL
  );
$$;

-- v_bids: tòa gán trực tiếp ∪ tòa theo KHU ∪ tòa hưởng lương LN
CREATE OR REPLACE FUNCTION public.accessible_building_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT sa.building_id FROM public.staff_assignments sa
   WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
  UNION
  SELECT ab.building_id FROM public.staff_assignments sa2
    JOIN public.area_buildings ab ON ab.area_id = sa2.area_id
   WHERE sa2.staff_id = auth.uid() AND sa2.area_id IS NOT NULL
  UNION
  SELECT pmsb.building_id
    FROM public.profit_manager_salary_buildings pmsb
    JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
    JOIN public.profit_managers pm ON pm.id = pms.manager_id
   WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL;
$$;

-- Tập invoice/room/contract id trong phạm vi. CỐ Ý không lọc deleted_at —
-- giữ đúng ngữ nghĩa can_access_building(building_of_*()) cũ.
CREATE OR REPLACE FUNCTION public.accessible_invoice_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT i.id FROM public.invoices i
  WHERE i.building_id IN (SELECT public.accessible_building_ids());
$$;

CREATE OR REPLACE FUNCTION public.accessible_room_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT r.id FROM public.rooms r
  WHERE r.building_id IN (SELECT public.accessible_building_ids());
$$;

CREATE OR REPLACE FUNCTION public.accessible_contract_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT c.id FROM public.contracts c
  JOIN public.rooms r ON r.id = c.room_id
  WHERE r.building_id IN (SELECT public.accessible_building_ids());
$$;

REVOKE ALL ON FUNCTION
  public.has_full_building_scope(), public.accessible_building_ids(),
  public.accessible_invoice_ids(), public.accessible_room_ids(),
  public.accessible_contract_ids()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.has_full_building_scope(), public.accessible_building_ids(),
  public.accessible_invoice_ids(), public.accessible_room_ids(),
  public.accessible_contract_ids()
TO authenticated;

-- ── 2. Initplan wrap TOÀN BỘ *_admin_all / *_super_admin_all (FOR ALL) ──
-- Xử _super_admin_all TRƯỚC rồi loại khỏi vòng _admin_all (bẫy LIKE trùng đuôi).
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND cmd = 'ALL'
      AND policyname LIKE '%\_super\_admin\_all'
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON public.%I USING ((SELECT public.is_super_admin())) WITH CHECK ((SELECT public.is_super_admin()))',
      pol.policyname, pol.tablename);
  END LOOP;

  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND cmd = 'ALL'
      AND policyname LIKE '%\_admin\_all'
      AND policyname NOT LIKE '%\_super\_admin\_all'
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON public.%I USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()))',
      pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ── 3. Set-based rewrite SELECT policy các bảng nóng ──

-- invoices: cũ = can_access_building(building_id)
ALTER POLICY invoices_select_rbac ON public.invoices USING (
  (SELECT public.has_full_building_scope())
  OR building_id IN (SELECT public.accessible_building_ids())
);

-- invoice_items: cũ = can_access_building(building_of_invoice(invoice_id))
ALTER POLICY invoice_items_select_rbac ON public.invoice_items USING (
  (SELECT public.has_full_building_scope())
  OR invoice_id IN (SELECT public.accessible_invoice_ids())
);

-- payments: cũ = can_access_building((SELECT building_id FROM invoices WHERE id = payments.invoice_id))
ALTER POLICY payments_select_rbac ON public.payments USING (
  (SELECT public.has_full_building_scope())
  OR invoice_id IN (SELECT public.accessible_invoice_ids())
);

-- contracts: GIỮ guard room_id IS NOT NULL — full-scope staff hiện KHÔNG thấy
-- HĐ không phòng (chỉ super/admin thấy), đừng mở rộng.
ALTER POLICY contracts_select_rbac ON public.contracts USING (
  (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (room_id IS NOT NULL AND (
        (SELECT public.has_full_building_scope())
        OR room_id IN (SELECT public.accessible_room_ids())
     ))
);

-- contract_customers: cũ = can_access_building(building_of_contract(contract_id))
-- (không guard room — full-scope pass mọi dòng, khớp has_full_building_scope()).
ALTER POLICY contract_customers_select_rbac ON public.contract_customers USING (
  (SELECT public.has_full_building_scope())
  OR contract_id IN (SELECT public.accessible_contract_ids())
);

-- rooms / buildings / area_buildings: cũ = can_access_building(<cột>)
ALTER POLICY rooms_select_rbac ON public.rooms USING (
  (SELECT public.has_full_building_scope())
  OR building_id IN (SELECT public.accessible_building_ids())
);

ALTER POLICY buildings_select_rbac ON public.buildings USING (
  (SELECT public.has_full_building_scope())
  OR id IN (SELECT public.accessible_building_ids())
);

ALTER POLICY area_buildings_select_rbac ON public.area_buildings USING (
  (SELECT public.has_full_building_scope())
  OR building_id IN (SELECT public.accessible_building_ids())
);

-- income_expenses (bảng chính trang Thu chi): cũ =
--   is_super_admin() OR is_admin() OR (building_id IS NOT NULL AND can_access_building(building_id))
-- 7 policy permissive khác của bảng này GIỮ NGUYÊN (OR-merge độc lập).
ALTER POLICY income_expenses_select_rbac ON public.income_expenses USING (
  (SELECT public.is_super_admin())
  OR (SELECT public.is_admin())
  OR (building_id IS NOT NULL AND (
        (SELECT public.has_full_building_scope())
        OR building_id IN (SELECT public.accessible_building_ids())
     ))
);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- ROLLBACK (nguyên văn USING cũ — chạy tay nếu cần):
-- ALTER POLICY invoices_select_rbac ON public.invoices
--   USING (public.can_access_building(building_id));
-- ALTER POLICY invoice_items_select_rbac ON public.invoice_items
--   USING (public.can_access_building(public.building_of_invoice(invoice_id)));
-- ALTER POLICY payments_select_rbac ON public.payments
--   USING (public.can_access_building((SELECT building_id FROM public.invoices WHERE id = payments.invoice_id)));
-- ALTER POLICY contracts_select_rbac ON public.contracts
--   USING (public.is_super_admin() OR public.is_admin() OR (room_id IS NOT NULL
--     AND public.can_access_building((SELECT building_id FROM public.rooms WHERE id = contracts.room_id))));
-- ALTER POLICY contract_customers_select_rbac ON public.contract_customers
--   USING (public.can_access_building(public.building_of_contract(contract_id)));
-- ALTER POLICY rooms_select_rbac ON public.rooms
--   USING (public.can_access_building(building_id));
-- ALTER POLICY buildings_select_rbac ON public.buildings
--   USING (public.can_access_building(id));
-- ALTER POLICY area_buildings_select_rbac ON public.area_buildings
--   USING (public.can_access_building(building_id));
-- ALTER POLICY income_expenses_select_rbac ON public.income_expenses
--   USING (public.is_super_admin() OR public.is_admin()
--     OR (building_id IS NOT NULL AND public.can_access_building(building_id)));
-- Vòng *_admin_all: bỏ (SELECT ...) quanh is_admin()/is_super_admin() nếu muốn revert.
-- =====================================================================
