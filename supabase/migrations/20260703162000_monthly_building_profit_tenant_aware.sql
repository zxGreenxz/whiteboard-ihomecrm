-- =============================================================================
-- FIX C2 (audit thanh lý 2026-07-03): monthly_building_profit khoá cứng chủ
-- super-admin đầu tiên → tenant khác (vd demo docs) gọi luôn nhận RỖNG.
--
-- Sau: xác định "chủ tenant" theo NGƯỜI GỌI:
--   1. Người gọi là super admin           → chính mình (số real tenant KHÔNG ĐỔI)
--   2. Người gọi là chủ tenant (có toà)   → chính mình
--   3. Người gọi là nhân viên             → chủ (user_id) của staff_assignments
--   4. Không đăng nhập (service/cron)     → fallback super admin đầu tiên (như cũ)
-- Phần tính toán giữ NGUYÊN (b.user_id = v_owner, ie.user_id = v_owner) — chủ
-- thật là super admin đầu tiên nên kết quả không đổi 1 đồng.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.monthly_building_profit(p_start date, p_end date, p_building_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(building_id uuid, building_name text, total_income numeric, total_expense numeric, net_profit numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := COALESCE(
    (SELECT sa.user_id FROM public.super_admins sa WHERE sa.user_id = auth.uid()),
    (SELECT b.user_id FROM public.buildings b
      WHERE b.user_id = auth.uid() AND b.deleted_at IS NULL LIMIT 1),
    (SELECT sa.user_id FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid() LIMIT 1),
    (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1)
  );

  RETURN QUERY
  SELECT
    b.id,
    b.name,
    COALESCE(i.total, 0)::numeric,
    COALESCE(e.total, 0)::numeric,
    (COALESCE(i.total, 0) - COALESCE(e.total, 0))::numeric
  FROM public.buildings b
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.kqkd_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'INCOME'
      AND ie.kqkd_amount > 0
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) i ON i.building_id = b.id
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.kqkd_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'EXPENSE'
      AND ie.kqkd_amount > 0
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) e ON e.building_id = b.id
  WHERE b.user_id = v_owner
    AND b.is_virtual = false
    AND b.deleted_at IS NULL
    AND (p_building_id IS NULL OR b.id = p_building_id)
  ORDER BY b.name;
END;
$function$;
