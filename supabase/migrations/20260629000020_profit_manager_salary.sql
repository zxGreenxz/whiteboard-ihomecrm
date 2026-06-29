-- =============================================
-- Migration: Lương điều hành (management salary) trong Phân bổ lợi nhuận
-- Description:
--   Khoản trả cho người QUẢN LÝ ĐIỀU HÀNH, được TRỪ khỏi LN từng nhà TRƯỚC khi
--   chia cho cổ đông (phần còn lại mới × % cổ đông).
--   - profit_managers: quản lý điều hành (gắn 1 tài khoản đăng nhập qua auth_user_id)
--   - profit_manager_salaries: quy tắc lương (FIXED/PERCENT × PER_BUILDING/TOTAL_GROUP)
--   - profit_manager_salary_buildings: tập nhà của 1 quy tắc
--   - profit_monthly.management_salary: snapshot tổng lương điều hành trừ ở nhà/tháng
--   - profit_manager_allocations: snapshot phần lương mỗi quản lý khi chốt
--   - income_expenses.profit_manager_id: gắn phiếu chi trả lương điều hành
--   - current_profit_manager_id(): map auth.uid() → profit_managers.id
--   - get_my_permissions()/can_access_building(): thêm nhánh quản lý (mirror cổ đông)
--   KHÁC module "Bảng lương quản lý" cũ (manager_salary_config / salary_staff_id).
-- =============================================

BEGIN;

-- 1) profit_managers ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profit_managers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT profit_managers_name_not_empty CHECK (char_length(name) > 0)
);
CREATE INDEX IF NOT EXISTS idx_profit_managers_user_id   ON public.profit_managers(user_id)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_profit_managers_auth_user ON public.profit_managers(auth_user_id) WHERE auth_user_id IS NOT NULL;
COMMENT ON TABLE public.profit_managers IS 'Quản lý điều hành — hưởng lương điều hành trừ khỏi LN trước khi chia cổ đông. auth_user_id = tài khoản đăng nhập (tự xem phần của mình).';

-- 2) profit_manager_salaries (quy tắc lương) -----------------------------
CREATE TABLE IF NOT EXISTS public.profit_manager_salaries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  manager_id  UUID NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
  label       TEXT,
  form        TEXT NOT NULL DEFAULT 'FIXED'  CHECK (form  IN ('FIXED','PERCENT')),
  basis       TEXT NOT NULL DEFAULT 'PER_BUILDING' CHECK (basis IN ('PER_BUILDING','TOTAL_GROUP')),
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount  >= 0),               -- form=FIXED
  percent     NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100), -- form=PERCENT
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_manager ON public.profit_manager_salaries(manager_id);
COMMENT ON TABLE public.profit_manager_salaries IS 'Quy tắc lương điều hành: FIXED(tiền thực)/PERCENT(% trên LN ròng) × PER_BUILDING/TOTAL_GROUP.';

-- 3) profit_manager_salary_buildings (tập nhà của 1 quy tắc) --------------
CREATE TABLE IF NOT EXISTS public.profit_manager_salary_buildings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  salary_id   UUID NOT NULL REFERENCES public.profit_manager_salaries(id) ON DELETE CASCADE,
  building_id UUID NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salary_id, building_id)
);
CREATE INDEX IF NOT EXISTS idx_pmsb_salary   ON public.profit_manager_salary_buildings(salary_id);
CREATE INDEX IF NOT EXISTS idx_pmsb_building ON public.profit_manager_salary_buildings(building_id);

-- 4) profit_monthly.management_salary ------------------------------------
ALTER TABLE public.profit_monthly
  ADD COLUMN IF NOT EXISTS management_salary NUMERIC(15,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.profit_monthly.management_salary IS
  'Snapshot tổng lương điều hành trừ ở nhà/tháng này. distributable = adjusted_profit - management_salary; cổ đông chia trên distributable.';

-- 5) profit_manager_allocations (snapshot phần mỗi quản lý) --------------
CREATE TABLE IF NOT EXISTS public.profit_manager_allocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profit_monthly_id UUID NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
  manager_id        UUID NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0,   -- snapshot lương trừ ở nhà này
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profit_monthly_id, manager_id)
);
CREATE INDEX IF NOT EXISTS idx_pma_manager ON public.profit_manager_allocations(manager_id);
CREATE INDEX IF NOT EXISTS idx_pma_user    ON public.profit_manager_allocations(user_id);

-- 6) income_expenses.profit_manager_id -----------------------------------
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS profit_manager_id UUID REFERENCES public.profit_managers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_income_expenses_profit_manager_id
  ON public.income_expenses(profit_manager_id) WHERE profit_manager_id IS NOT NULL;
COMMENT ON COLUMN public.income_expenses.profit_manager_id IS
  'Phiếu chi trả lương điều hành gắn quản lý — tính "đã trả/còn lại". Phiếu loại này đặt business_result_accounting=false (đã trừ ở tầng phân bổ).';

-- updated_at triggers (idempotent) ---------------------------------------
DROP TRIGGER IF EXISTS set_profit_managers_updated_at ON public.profit_managers;
CREATE TRIGGER set_profit_managers_updated_at BEFORE UPDATE ON public.profit_managers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_pms_updated_at ON public.profit_manager_salaries;
CREATE TRIGGER set_pms_updated_at BEFORE UPDATE ON public.profit_manager_salaries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7) Helper: auth.uid() → profit_managers.id -----------------------------
CREATE OR REPLACE FUNCTION public.current_profit_manager_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.profit_managers
  WHERE auth_user_id = auth.uid() AND deleted_at IS NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.current_profit_manager_id() TO authenticated;

-- 8) Seed hạng mục chi "Lương điều hành" cho owner -----------------------
INSERT INTO public.income_expense_types (user_id, name, type, category, is_default, is_deposit, description)
SELECT sa.user_id, 'Lương điều hành', 'expense', 'Chia lợi nhuận', false, false,
       'Phiếu chi trả lương điều hành — không tính KQKD (đã trừ ở tầng phân bổ LN)'
FROM public.super_admins sa
WHERE NOT EXISTS (
  SELECT 1 FROM public.income_expense_types t
  WHERE t.user_id = sa.user_id AND lower(t.type) = 'expense' AND t.name = 'Lương điều hành'
);

-- 9) Grants + RLS --------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profit_managers                  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profit_manager_salaries          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profit_manager_salary_buildings  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profit_manager_allocations       TO authenticated;

ALTER TABLE public.profit_managers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_manager_salaries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_manager_salary_buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_manager_allocations      ENABLE ROW LEVEL SECURITY;

-- profit_managers: owner/admin full; quản lý xem chính mình
DROP POLICY IF EXISTS profit_managers_owner_all ON public.profit_managers;
CREATE POLICY profit_managers_owner_all ON public.profit_managers TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS profit_managers_self_select ON public.profit_managers;
CREATE POLICY profit_managers_self_select ON public.profit_managers FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() AND deleted_at IS NULL);

-- profit_manager_salaries: owner/admin full; quản lý xem quy tắc của mình
DROP POLICY IF EXISTS pms_owner_all ON public.profit_manager_salaries;
CREATE POLICY pms_owner_all ON public.profit_manager_salaries TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS pms_self_select ON public.profit_manager_salaries;
CREATE POLICY pms_self_select ON public.profit_manager_salaries FOR SELECT TO authenticated
  USING (manager_id = public.current_profit_manager_id());

-- profit_manager_salary_buildings: owner/admin full; quản lý xem nhà của mình
DROP POLICY IF EXISTS pmsb_owner_all ON public.profit_manager_salary_buildings;
CREATE POLICY pmsb_owner_all ON public.profit_manager_salary_buildings TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS pmsb_self_select ON public.profit_manager_salary_buildings;
CREATE POLICY pmsb_self_select ON public.profit_manager_salary_buildings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profit_manager_salaries s
    WHERE s.id = profit_manager_salary_buildings.salary_id
      AND s.manager_id = public.current_profit_manager_id()
  ));

-- profit_manager_allocations: owner/admin full; quản lý xem phần của mình
DROP POLICY IF EXISTS pma_owner_all ON public.profit_manager_allocations;
CREATE POLICY pma_owner_all ON public.profit_manager_allocations TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS pma_self_select ON public.profit_manager_allocations;
CREATE POLICY pma_self_select ON public.profit_manager_allocations FOR SELECT TO authenticated
  USING (manager_id = public.current_profit_manager_id());

-- profit_monthly: thêm policy cho quản lý xem tháng có phần lương của mình
-- (cộng thêm policy hiện có cho cổ đông — nhiều policy SELECT là OR).
DROP POLICY IF EXISTS profit_monthly_self_manager ON public.profit_monthly;
CREATE POLICY profit_monthly_self_manager ON public.profit_monthly FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profit_manager_allocations pma
    WHERE pma.profit_monthly_id = profit_monthly.id
      AND pma.manager_id = public.current_profit_manager_id()
  ));

-- income_expenses: quản lý xem phiếu trả lương gắn mình
DROP POLICY IF EXISTS income_expenses_select_profit_manager ON public.income_expenses;
CREATE POLICY income_expenses_select_profit_manager ON public.income_expenses FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND profit_manager_id = public.current_profit_manager_id());

-- 10) can_access_building: thêm nhánh quản lý (đọc đúng nhà mình quản lý) --
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (sa.building_id IS NULL OR sa.building_id = _building_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.building_shareholders bs
      JOIN public.shareholders s ON s.id = bs.shareholder_id
      WHERE s.auth_user_id = auth.uid()
        AND s.deleted_at IS NULL
        AND bs.building_id = _building_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.profit_manager_salary_buildings pmsb
      JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
      JOIN public.profit_managers pm ON pm.id = pms.manager_id
      WHERE pm.auth_user_id = auth.uid()
        AND pm.deleted_at IS NULL
        AND pmsb.building_id = _building_id
    );
$function$;

-- 11) get_my_permissions: nhánh quản lý (read-only, mirror cổ đông) -------
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_perms          jsonb;
  v_is_shareholder boolean;
  v_is_manager     boolean;
  v_sh_perms       jsonb := jsonb_build_object(
    'dashboard',           jsonb_build_object('view', true),
    'notifications',       jsonb_build_object('view', true),
    'buildings',           jsonb_build_object('view', true),
    'rooms',               jsonb_build_object('view', true),
    'services',            jsonb_build_object('view', true),
    'leads',               jsonb_build_object('view', true),
    'deposits',            jsonb_build_object('view', true),
    'contracts',           jsonb_build_object('view', true),
    'customers',           jsonb_build_object('view', true),
    'vehicles',            jsonb_build_object('view', true),
    'cashbooks',           jsonb_build_object('view', true),
    'invoices',            jsonb_build_object('view', true),
    'income_expenses',     jsonb_build_object('view', true),
    'meter_readings',      jsonb_build_object('view', true),
    'assets',              jsonb_build_object('view', true),
    'tasks',               jsonb_build_object('view', true),
    'reports_real_estate', jsonb_build_object('view', true),
    'reports_finance',     jsonb_build_object('view', true),
    'shareholder_profit',  jsonb_build_object('view', true),
    'personal_finance',    jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true)
  );
BEGIN
  IF v_caller IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Super admin bypass
  IF EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = v_caller) THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  -- Staff: lấy permissions từ assignment đầu tiên (full-scope ưu tiên)
  SELECT COALESCE(sa.permissions, r.permissions)
    INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;

  v_is_shareholder := EXISTS (
    SELECT 1 FROM public.shareholders
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );
  v_is_manager := EXISTS (
    SELECT 1 FROM public.profit_managers
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );

  -- Cổ đông HOẶC quản lý điều hành: thêm/giữ quyền chỉ-xem.
  -- merge `v_sh_perms || v_perms` → key của staff GHI ĐÈ base (giữ quyền cao
  -- hơn của staff cho module trùng); shareholder_profit/personal_finance chỉ có
  -- ở base nên luôn được giữ.
  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN
      RETURN v_sh_perms;
    END IF;
    RETURN v_sh_perms || v_perms;
  END IF;

  -- Owner thật (không staff, không cổ đông, không quản lý) → bypass (giữ hành vi cũ)
  IF v_perms IS NULL THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  RETURN v_perms;
END
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
