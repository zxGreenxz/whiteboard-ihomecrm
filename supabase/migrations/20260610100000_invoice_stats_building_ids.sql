-- =====================================================================
-- get_invoice_statistics_v2: thêm p_building_ids uuid[] — lọc nhiều toà
--
-- Phục vụ chuẩn hoá filter "khu vực = nhóm toà nhà": FE chọn nhiều toà
-- (BuildingMultiSelect, click khu = chọn cả nhóm) và gửi thẳng mảng
-- building_ids xuống stats, thay vì p_area_id resolve trong SQL.
--
-- PHẢI DROP signature cũ rồi CREATE mới: thêm param DEFAULT tạo OVERLOAD
-- thứ hai → PostgREST báo PGRST203 ambiguous khi FE gọi thiếu param mới.
--
-- p_area_id giữ lại (deprecated) cho tương thích trong thời gian chuyển
-- đổi; sẽ gỡ sau khi mọi trang FE dùng building_ids.
-- =====================================================================

DROP FUNCTION IF EXISTS public.get_invoice_statistics_v2(
  UUID, UUID, invoice_status, DATE, DATE, TEXT, TEXT, UUID
);

CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(
  p_building_id    UUID DEFAULT NULL,
  p_room_id        UUID DEFAULT NULL,
  p_status         invoice_status DEFAULT NULL,
  p_start_date     DATE DEFAULT NULL,
  p_end_date       DATE DEFAULT NULL,
  p_billing_month  TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL,
  p_area_id        UUID DEFAULT NULL,
  p_building_ids   UUID[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    LEFT JOIN public.buildings b ON b.id = i.building_id
    WHERE i.deleted_at IS NULL
      AND public.can_access_building(i.building_id)
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
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
  LEFT JOIN public.buildings b ON b.id = i.building_id
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
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
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
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
  LEFT JOIN public.buildings b ON b.id = i.building_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id       = p_area_id)
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
  LEFT JOIN public.buildings b ON b.id = ie.building_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND public.can_access_building(ie.building_id)
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_area_id       IS NULL OR b.area_id        = p_area_id)
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
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_statistics_v2(
  UUID, UUID, invoice_status, DATE, DATE, TEXT, TEXT, UUID, UUID[]
) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_invoice_statistics_v2(
  UUID, UUID, invoice_status, DATE, DATE, TEXT, TEXT, UUID, UUID[]
) TO authenticated;

NOTIFY pgrst, 'reload schema';
