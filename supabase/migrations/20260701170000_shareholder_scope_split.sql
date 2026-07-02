-- =====================================================================
-- TÁCH QUYỀN CỔ ĐÔNG khỏi khu VẬN HÀNH (theo yêu cầu chủ 2026-07-01).
--
-- Nguyên tắc mới: cổ đông chỉ có ĐÚNG 1 cửa — trang "Phân bổ & chia lợi nhuận"
-- (dữ liệu tự giới hạn theo cổ phần qua RLS self của module lợi nhuận:
-- shareholders_self_select / profit_alloc_self_select /
-- income_expenses_select_shareholder — KHÔNG đụng ở đây, vẫn nguyên).
-- Toàn bộ khu vận hành (32 bảng *_select_rbac qua can_access_building: hóa đơn,
-- phiếu thu, hợp đồng, phòng, buildings…) ĐÓNG với vai cổ đông.
--
-- 1) can_access_building(): BỎ nhánh cổ đông (building_shareholders). Đồng thời
--    KHÔI PHỤC nhánh khu vực (area_buildings) đã bị rơi ở 20260629000020
--    (full-scope phải là building_id NULL AND area_id NULL). Giữ nhánh
--    profit_manager (pmsb — hiện chỉ chủ dùng, thuộc module lương).
-- 2) get_invoice_statistics_v2(): v_bids bỏ building_shareholders, thêm area
--    (đồng bộ với can_access_building — hàm này là bản inline hoá của nó).
-- 3) get_my_permissions(): cổ đông/quản-lý-LN thuần chỉ còn
--    { shareholder_profit: { view: true } } — KHÔNG còn ~20 module view +
--    personal_finance như trước. Ai kiêm nhân viên giữ nguyên quyền staff
--    (merge base || staff, staff ghi đè).
-- 4) get_my_share_buildings(): RPC mới (SECURITY DEFINER) trả id+tên các tòa
--    caller có cổ phần / hưởng lương LN — để trang lợi nhuận hiển thị TÊN TÒA
--    mà không cần mở bảng buildings.
-- =====================================================================

BEGIN;

-- ── 1. can_access_building: staff (building/area/full) + profit-manager; BỎ cổ đông ──
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
        AND (
          (sa.building_id IS NULL AND sa.area_id IS NULL)   -- full scope
          OR sa.building_id = _building_id                  -- gán tòa cụ thể
          OR (sa.area_id IS NOT NULL AND EXISTS (           -- gán theo KHU (live)
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

-- ── 2. get_invoice_statistics_v2: scope đồng bộ (vá từ live def) ──
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

  -- Cọc đã thu — filter theo ie.building_id/room_id/voucher_date.
  SELECT COALESCE(SUM(ie.total_amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_priv OR ie.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
    AND EXISTS (
      SELECT 1
      FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
    );

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
$function$
;

-- ── 3. get_my_permissions: cổ đông thuần = ĐÚNG 1 quyền ──
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_perms          jsonb;
  v_is_shareholder boolean;
  v_is_manager     boolean;
  -- Cổ đông / quản lý lợi nhuận: CHỈ trang Phân bổ & chia lợi nhuận.
  -- Muốn cho cổ đông xem thêm gì → thêm vào TRANG đó, không mở module khác.
  v_sh_perms       jsonb := jsonb_build_object(
    'shareholder_profit', jsonb_build_object('view', true)
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

  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN
      RETURN v_sh_perms;          -- cổ đông THUẦN: đúng 1 quyền
    END IF;
    RETURN v_sh_perms || v_perms; -- kiêm nhân viên: quyền staff + cửa trang LN
  END IF;

  -- Owner thật (không staff, không cổ đông, không quản lý) → bypass (giữ hành vi cũ)
  IF v_perms IS NULL THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  RETURN v_perms;
END
$function$;

-- ── 4. RPC tên tòa cho trang lợi nhuận (không mở bảng buildings) ──
CREATE OR REPLACE FUNCTION public.get_my_share_buildings()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT DISTINCT b.id, b.name
  FROM public.buildings b
  WHERE b.deleted_at IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.building_shareholders bs
        JOIN public.shareholders s ON s.id = bs.shareholder_id
        WHERE s.auth_user_id = auth.uid() AND s.deleted_at IS NULL
          AND bs.building_id = b.id
      )
      OR EXISTS (
        SELECT 1 FROM public.profit_manager_salary_buildings pmsb
        JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
        JOIN public.profit_managers pm ON pm.id = pms.manager_id
        WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL
          AND pmsb.building_id = b.id
      )
    );
$function$;
REVOKE ALL ON FUNCTION public.get_my_share_buildings() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_share_buildings() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
