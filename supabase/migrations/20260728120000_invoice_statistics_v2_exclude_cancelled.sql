-- =====================================================================
-- A1 — get_invoice_statistics_v2: LOẠI hoá đơn đã HUỶ khỏi thống kê
--
-- BUG: hàm này không có bộ lọc status ở BỐN khối truy vấn join `invoices`
-- (filtered_invoices / invoice_items / payments / change_amount), nên hoá đơn
-- CANCELLED vẫn được cộng vào "Phải thu". Đo trên org thật: 29 hoá đơn
-- CANCELLED còn remaining_amount > 0 = 127.429.166đ công nợ MA trên màn hình
-- Thống kê hoá đơn. Sáu màn hình AR khác đã lọc sẵn — đây là chỗ duy nhất sót.
--
-- CÁCH SỬA: thêm guard vào CẢ BỐN khối (không phải chỉ khối đầu).
--   • Lọc cả 4 → "Đã thu" (total_paid) và TM/TK/TT/CT vẫn khớp nhau:
--     total_paid − total_collected = 23.463.066đ trước VÀ sau.
--   • Chỉ lọc khối đầu → con số đó tụt còn 3.466.066đ, tức "Đã thu" mất
--     tiền mặt CÓ THẬT đã thu trên hoá đơn sau đó bị huỷ. Không được làm vậy.
--
-- GIỮ ĐƯỜNG THOÁT: khi caller hỏi đích danh p_status='CANCELLED' (view
-- "Đã huỷ" trên trang hoá đơn) thì vẫn trả số như cũ, nếu không màn hình đó
-- sẽ hiện toàn số 0.
--
-- KHÔNG đụng khối `deposit_collected` — khối đó không join `invoices` và
-- không được phép đổi sau đợt backfill phiếu cọc 28/07/2026.
--
-- Chữ ký GIỮ NGUYÊN 100% ⇒ CREATE OR REPLACE thay thế tại chỗ, không tạo
-- overload (tránh PGRST203), không mất GRANT, giữ SECURITY DEFINER/search_path.
-- =====================================================================

begin;

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
      -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi
      -- caller hỏi ĐÍCH DANH p_status=CANCELLED (view "Đã huỷ" trang hoá đơn).
      AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::invoice_status
           OR i.status <> 'CANCELLED')
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
    -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi
    -- caller hỏi ĐÍCH DANH p_status=CANCELLED (view "Đã huỷ" trang hoá đơn).
    AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::invoice_status
         OR i.status <> 'CANCELLED')
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
    COALESCE(SUM(p.collected_amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.collected_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.collected_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.collected_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'CT' THEN p.collected_amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt, v_payment_ct
  FROM public.active_payment_receipts p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi
    -- caller hỏi ĐÍCH DANH p_status=CANCELLED (view "Đã huỷ" trang hoá đơn).
    AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::invoice_status
         OR i.status <> 'CANCELLED')
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
    AND (
      ie.payment_collection_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.invoice_payment_collections active_collection
        WHERE active_collection.id = ie.payment_collection_id
          AND active_collection.status = 'ACTIVE'
      )
    )
    AND (
      ie.payment_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.active_payments active_payment
        WHERE active_payment.id = ie.payment_id
      )
    )
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi
    -- caller hỏi ĐÍCH DANH p_status=CANCELLED (view "Đã huỷ" trang hoá đơn).
    AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::invoice_status
         OR i.status <> 'CANCELLED')
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
    AND (
      ie.payment_collection_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.invoice_payment_collections active_collection
        WHERE active_collection.id = ie.payment_collection_id
          AND active_collection.status = 'ACTIVE'
      )
    )
    AND (
      ie.payment_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.active_payments active_payment
        WHERE active_payment.id = ie.payment_id
      )
    )
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

-- Đảm bảo PostgREST nạp lại schema cache.
notify pgrst, 'reload schema';

commit;
