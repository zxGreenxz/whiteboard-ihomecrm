-- =============================================================================
-- ẨN TENANT DEMO (sandbox docs) KHỎI ADMIN THẬT (NG TÂM / super_admin / Admin)
-- =============================================================================
-- Bối cảnh: sandbox docs = tenant riêng (owner demo.chunha) gồm 2 tòa DEMOA/DEMOB
-- + khách/HĐ/hoá đơn/nhân viên demo. RLS admin bypass (is_super_admin/is_admin)
-- xuyên tenant nên admin thật vẫn thấy toàn bộ dữ liệu demo trong mọi danh sách
-- và báo cáo. Yêu cầu: loại demo khỏi tài khoản admin thật, NHƯNG các tài khoản
-- demo (không phải admin) phải tiếp tục thấy để sandbox hoạt động.
--
-- Cách làm (3 lớp, KHÔNG sửa policy hiện có):
--  1) 2 helper SECDEF nhận diện demo: demo_user_ids() / demo_building_ids().
--  2) RESTRICTIVE policy (AND với mọi policy permissive) trên các bảng danh sách:
--     chặn row demo KHI VIEWER là admin (is_super_admin OR is_admin). Demo user
--     không phải admin → không bị chặn. postgres/service_role bypass RLS →
--     seed/reset không ảnh hưởng. Gỡ demo sau này: DROP các policy *_hide_demo_admin.
--  3) Vá 2 hàm SECURITY DEFINER (bypass RLS nên restrictive không với tới):
--     - can_access_building: nhánh đặc quyền (super/admin/full-scope) loại tòa demo
--       → sạch mọi RPC fa_*/breakdown/ie_form_* dùng hàm này.
--     - get_invoice_statistics_v2: nhánh v_priv hạ xuống "mọi tòa TRỪ demo".
-- =============================================================================

-- ===== 1. Helpers =====
CREATE OR REPLACE FUNCTION public.demo_user_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(id), '{}'::uuid[])
  FROM auth.users
  WHERE email LIKE 'demo.%@username.ihomecrm.local';
$$;
REVOKE ALL ON FUNCTION public.demo_user_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demo_user_ids() TO authenticated, service_role;
COMMENT ON FUNCTION public.demo_user_ids() IS
  '[DEMO-DOCS] uuid các tài khoản demo sandbox (demo.*@username.ihomecrm.local)';

CREATE OR REPLACE FUNCTION public.demo_building_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(id), '{}'::uuid[])
  FROM public.buildings
  WHERE user_id = ANY (public.demo_user_ids());
$$;
REVOKE ALL ON FUNCTION public.demo_building_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demo_building_ids() TO authenticated, service_role;
COMMENT ON FUNCTION public.demo_building_ids() IS
  '[DEMO-DOCS] uuid các tòa thuộc tenant demo sandbox';

-- ===== 2. RESTRICTIVE policies =====
-- Bảng có user_id (chủ sở hữu row = tenant): chặn khi viewer admin & row demo.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'buildings','contracts','contract_extensions','invoices','income_expenses',
    'payments','meter_readings','deposits','customers','tenants','vehicles',
    'leads','ct01_declarations','jobs','materials','material_purchases',
    'material_usages','material_adjustments','assets','asset_movements',
    'asset_maintenance','asset_handovers','services','income_expense_types',
    'meters','areas','area_buildings','accounts','staff_assignments','roles',
    'shareholders','building_shareholders'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_hide_demo_admin', t);
    EXECUTE format(
      $p$CREATE POLICY %I ON public.%I
           AS RESTRICTIVE FOR SELECT TO authenticated
           USING (NOT (
             (SELECT public.is_super_admin() OR public.is_admin())
             AND user_id IN (SELECT unnest(public.demo_user_ids()))
           ))$p$,
      t || '_hide_demo_admin', t);
  END LOOP;
END $$;

-- rooms & building_services: không có user_id → nhận diện qua tòa demo.
DROP POLICY IF EXISTS rooms_hide_demo_admin ON public.rooms;
CREATE POLICY rooms_hide_demo_admin ON public.rooms
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (
    (SELECT public.is_super_admin() OR public.is_admin())
    AND building_id IN (SELECT unnest(public.demo_building_ids()))
  ));

DROP POLICY IF EXISTS building_services_hide_demo_admin ON public.building_services;
CREATE POLICY building_services_hide_demo_admin ON public.building_services
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (
    (SELECT public.is_super_admin() OR public.is_admin())
    AND building_id IN (SELECT unnest(public.demo_building_ids()))
  ));

-- profiles: id chính là auth user id.
DROP POLICY IF EXISTS profiles_hide_demo_admin ON public.profiles;
CREATE POLICY profiles_hide_demo_admin ON public.profiles
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (
    (SELECT public.is_super_admin() OR public.is_admin())
    AND id IN (SELECT unnest(public.demo_user_ids()))
  ));

-- ===== 3a. can_access_building: nhánh đặc quyền loại tòa demo =====
-- (redefine từ bản LIVE 2026-07-03; nhánh scoped/khu vực/profit-manager GIỮ NGUYÊN
--  → tài khoản demo gán per-building vẫn truy cập bình thường)
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    (
      ( public.is_super_admin()
        OR public.is_admin()
        OR EXISTS (                                       -- full scope
             SELECT 1 FROM public.staff_assignments sa
             WHERE sa.staff_id = auth.uid()
               AND sa.building_id IS NULL AND sa.area_id IS NULL
           )
      )
      AND NOT (_building_id = ANY (public.demo_building_ids()))  -- [DEMO-DOCS] ẩn tòa demo khỏi đặc quyền
    )
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (
          sa.building_id = _building_id                  -- gán tòa cụ thể
          OR (sa.area_id IS NOT NULL AND EXISTS (        -- gán theo KHU (live)
                SELECT 1 FROM public.area_buildings ab
                WHERE ab.area_id = sa.area_id
                  AND ab.building_id = _building_id
             ))
        )
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

-- ===== 3b. get_invoice_statistics_v2: v_priv hạ xuống "mọi tòa TRỪ demo" =====
CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT         := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
  v_payment_ct        DECIMAL(15, 2) := 0;
  v_priv              BOOLEAN        := FALSE;  -- thấy mọi toà
  v_bids              uuid[]         := NULL;   -- tập toà được phép (khi không priv)
BEGIN
  -- Tính phạm vi toà MỘT lần (thay can_access_building per-row).
  IF public.is_super_admin() OR public.is_admin()
     OR EXISTS (
       SELECT 1 FROM public.staff_assignments sa
       WHERE sa.staff_id = auth.uid() AND sa.building_id IS NULL AND sa.area_id IS NULL
     ) THEN
    v_priv := TRUE;
  ELSE
    SELECT array_agg(DISTINCT b) INTO v_bids
    FROM (
      SELECT sa.building_id AS b
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
      UNION
      SELECT ab.building_id
      FROM public.staff_assignments sa2
      JOIN public.area_buildings ab ON ab.area_id = sa2.area_id
      WHERE sa2.staff_id = auth.uid() AND sa2.area_id IS NOT NULL
      UNION
      SELECT pmsb.building_id
      FROM public.profit_manager_salary_buildings pmsb
      JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
      JOIN public.profit_managers pm ON pm.id = pms.manager_id
      WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL
    ) q;
  END IF;

  -- [DEMO-DOCS] Đặc quyền không bao gồm tòa demo sandbox: hạ v_priv xuống
  -- danh sách "MỌI tòa TRỪ demo" (kể cả tòa đã soft-delete — giữ nguyên hành vi
  -- cũ với hoá đơn thuộc tòa đã xoá mềm) để thống kê không lẫn số liệu demo.
  IF v_priv THEN
    v_priv := FALSE;
    SELECT array_agg(id) INTO v_bids
    FROM public.buildings
    WHERE NOT (id = ANY (public.demo_building_ids()));
  END IF;

  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    WHERE i.deleted_at IS NULL
      AND (v_priv OR i.building_id = ANY(v_bids))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO v_total_amount, v_total_paid, v_total_remaining, v_total_refunded, v_total_count
  FROM filtered_invoices;

  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO v_rent_amount, v_electric_amount, v_water_amount, v_pdv_amount
  FROM public.invoices i
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'CT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt, v_payment_ct
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM public.income_expenses ie
  JOIN public.invoices i ON i.id = ie.invoice_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- Cọc đã thu — Σ ITEM cọc (phiếu trộn chỉ tính phần cọc, không lôi cả total).
  SELECT COALESCE(SUM(it.amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  JOIN public.income_expense_items it ON it.income_expense_id = ie.id
  JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_priv OR ie.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month);

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'payment_ct',         v_payment_ct,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$function$;
