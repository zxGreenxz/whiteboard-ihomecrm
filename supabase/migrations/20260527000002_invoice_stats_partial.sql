-- =============================================
-- Migration: get_invoice_statistics — hỗ trợ payment_status='partial'
-- Created: 2026-05-27
-- Description:
--   Thêm case 'partial' (= status PARTIAL_PAID) cho p_payment_status filter
--   và đổi semantics 'unpaid' thành "chưa thu đồng nào" (loại cả PAID lẫn
--   PARTIAL_PAID) — khớp với filter mới trên UI invoice list.
-- =============================================

DROP FUNCTION IF EXISTS get_invoice_statistics(UUID, UUID, UUID, invoice_status, DATE, DATE, TEXT, TEXT, UUID, UUID) CASCADE;

CREATE OR REPLACE FUNCTION get_invoice_statistics(
  p_user_id UUID,
  p_building_id UUID DEFAULT NULL,
  p_room_id UUID DEFAULT NULL,
  p_status invoice_status DEFAULT NULL,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_billing_month TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL,
  p_bed_id UUID DEFAULT NULL,
  p_area_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_caller           UUID := auth.uid();
  v_is_super         BOOLEAN := FALSE;
  v_owner            UUID;
  v_staff_buildings  UUID[];
  v_total_paid       DECIMAL(15, 2) := 0;
  v_total_remaining  DECIMAL(15, 2) := 0;
  v_total_amount     DECIMAL(15, 2) := 0;
  v_total_refunded   DECIMAL(15, 2) := 0;
  v_total_count      BIGINT := 0;
  v_rent_amount      DECIMAL(15, 2) := 0;
  v_electric_amount  DECIMAL(15, 2) := 0;
  v_water_amount     DECIMAL(15, 2) := 0;
  v_pdv_amount       DECIMAL(15, 2) := 0;
  v_total_collected  DECIMAL(15, 2) := 0;
  v_payment_tm       DECIMAL(15, 2) := 0;
  v_payment_tk       DECIMAL(15, 2) := 0;
  v_payment_tt       DECIMAL(15, 2) := 0;
  v_change_amount    DECIMAL(15, 2) := 0;
BEGIN
  -- 1) Determine effective owner & staff building scope.
  IF v_caller IS NULL THEN
    v_owner := p_user_id;
    v_staff_buildings := NULL;
  ELSE
    SELECT EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = v_caller)
      INTO v_is_super;

    IF v_is_super THEN
      v_owner := COALESCE(p_user_id, v_caller);
      v_staff_buildings := NULL;
    ELSE
      SELECT sa.user_id INTO v_owner
      FROM staff_assignments sa
      WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
      LIMIT 1;

      IF v_owner IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NULL
        ) THEN
          v_staff_buildings := NULL;
        ELSE
          SELECT array_agg(building_id) INTO v_staff_buildings
          FROM staff_assignments
          WHERE staff_id = v_caller AND user_id = v_owner AND building_id IS NOT NULL;
        END IF;
      ELSE
        v_owner := v_caller;
        v_staff_buildings := NULL;
      END IF;
    END IF;
  END IF;

  -- 2) Aggregates trên bảng invoices
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM invoices i
    LEFT JOIN buildings b ON b.id = i.building_id
    WHERE i.user_id = v_owner
      AND i.deleted_at IS NULL
      AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
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
  INTO
    v_total_amount,
    v_total_paid,
    v_total_remaining,
    v_total_refunded,
    v_total_count
  FROM filtered_invoices;

  -- 3) Breakdown Điện/Nước/PDV theo description
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
  INTO
    v_rent_amount,
    v_electric_amount,
    v_water_amount,
    v_pdv_amount
  FROM invoices i
  LEFT JOIN buildings b ON b.id = i.building_id
  JOIN invoice_items ii ON ii.invoice_id = i.id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
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

  -- 4) Tổng tiền thu + chia theo phương thức
  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0)
  INTO
    v_total_collected,
    v_payment_tm,
    v_payment_tk,
    v_payment_tt
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE i.user_id = v_owner
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
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

  -- 5) Tiền Thối
  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM income_expenses ie
  JOIN invoices i ON i.id = ie.invoice_id
  LEFT JOIN buildings b ON b.id = i.building_id
  WHERE ie.user_id = v_owner
    AND ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_staff_buildings IS NULL OR i.building_id = ANY(v_staff_buildings))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_bed_id        IS NULL OR i.bed_id        = p_bed_id)
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

  RETURN json_build_object(
    'total_amount',      v_total_amount,
    'total_paid',        v_total_paid,
    'total_remaining',   v_total_remaining,
    'total_refunded',    v_total_refunded,
    'total_count',       v_total_count,
    'rent_amount',       v_rent_amount,
    'electric_amount',   v_electric_amount,
    'water_amount',      v_water_amount,
    'pdv_amount',        v_pdv_amount,
    'total_collected',   v_total_collected,
    'payment_tm',        v_payment_tm,
    'payment_tk',        v_payment_tk,
    'payment_tt',        v_payment_tt,
    'change_amount',     v_change_amount
  );
END;
$BODY$;
