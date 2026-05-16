-- =============================================
-- Migration: Extend get_invoice_statistics
-- Created: 2026-05-16
-- Description:
--   - Mở rộng RPC trả thêm: total_amount, rent_amount, electric_amount,
--     water_amount, pdv_amount, total_collected, total_refunded,
--     payment_tm/tk/tt, change_amount.
--   - Thêm filter: p_billing_month, p_payment_status, p_bed_id, p_area_id.
--   - Phân loại điện/nước dựa trên meters.meter_type (LEFT JOIN qua service_id),
--     fallback theo services.name khi chưa có meter.
-- =============================================

DROP FUNCTION IF EXISTS get_invoice_statistics(UUID, UUID, UUID, invoice_status, DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION get_invoice_statistics(
  p_user_id UUID,
  p_building_id UUID DEFAULT NULL,
  p_room_id UUID DEFAULT NULL,
  p_status invoice_status DEFAULT NULL,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_billing_month TEXT DEFAULT NULL,
  p_payment_status TEXT DEFAULT NULL, -- 'paid' | 'unpaid' | NULL
  p_bed_id UUID DEFAULT NULL,
  p_area_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
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
  -- Aggregates trên bảng invoices (đã filter)
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount, i.contract_id
    FROM invoices i
    LEFT JOIN buildings b ON b.id = i.building_id
    WHERE i.user_id = p_user_id
      AND i.deleted_at IS NULL
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
        OR (p_payment_status = 'paid'   AND i.status = 'PAID')
        OR (p_payment_status = 'unpaid' AND i.status <> 'PAID')
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

  -- Breakdown theo loại item (RENT / điện / nước / PDV)
  -- LATERAL để 1 service chỉ lấy 1 meter_type (tránh nhân đôi amount khi service có nhiều meter).
  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type = 'SERVICE' AND (
        m.meter_type = 'ELECTRICITY'
        OR (m.meter_type IS NULL AND (
          s.name ILIKE '%điện%' OR s.name ILIKE '%dien%'
          OR ii.description ILIKE '%điện%' OR ii.description ILIKE '%dien%'
        ))
      ) THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type = 'SERVICE' AND (
        m.meter_type = 'WATER'
        OR (m.meter_type IS NULL AND (
          s.name ILIKE '%nước%' OR s.name ILIKE '%nuoc%'
          OR ii.description ILIKE '%nước%' OR ii.description ILIKE '%nuoc%'
        ))
      ) THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type IN ('SERVICE','PENALTY','OTHER')
        AND NOT (
          m.meter_type IN ('ELECTRICITY','WATER')
          OR (m.meter_type IS NULL AND ii.type = 'SERVICE' AND (
            s.name ILIKE '%điện%' OR s.name ILIKE '%dien%'
            OR s.name ILIKE '%nước%' OR s.name ILIKE '%nuoc%'
            OR ii.description ILIKE '%điện%' OR ii.description ILIKE '%dien%'
            OR ii.description ILIKE '%nước%' OR ii.description ILIKE '%nuoc%'
          ))
        )
      THEN ii.amount ELSE 0 END), 0)
  INTO
    v_rent_amount,
    v_electric_amount,
    v_water_amount,
    v_pdv_amount
  FROM invoices i
  LEFT JOIN buildings b ON b.id = i.building_id
  JOIN invoice_items ii ON ii.invoice_id = i.id
  LEFT JOIN services s ON s.id = ii.service_id
  LEFT JOIN LATERAL (
    SELECT meter_type FROM meters mt
    WHERE mt.service_id = s.id AND mt.deleted_at IS NULL
    LIMIT 1
  ) m ON TRUE
  WHERE i.user_id = p_user_id
    AND i.deleted_at IS NULL
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
      OR (p_payment_status = 'paid'   AND i.status = 'PAID')
      OR (p_payment_status = 'unpaid' AND i.status <> 'PAID')
    );

  -- Tổng tiền thu thực tế + chia theo phương thức (TM/TK/TT)
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
  WHERE i.user_id = p_user_id
    AND i.deleted_at IS NULL
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
      OR (p_payment_status = 'paid'   AND i.status = 'PAID')
      OR (p_payment_status = 'unpaid' AND i.status <> 'PAID')
    );

  -- Tiền Thối = excess_amounts (positive = credit dư của khách) trên các invoice trong scope
  SELECT COALESCE(SUM(ea.amount), 0)
  INTO v_change_amount
  FROM excess_amounts ea
  WHERE ea.user_id = p_user_id
    AND ea.amount > 0
    AND ea.source_invoice_id IN (
      SELECT i.id
      FROM invoices i
      LEFT JOIN buildings b ON b.id = i.building_id
      WHERE i.user_id = p_user_id
        AND i.deleted_at IS NULL
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
          OR (p_payment_status = 'paid'   AND i.status = 'PAID')
          OR (p_payment_status = 'unpaid' AND i.status <> 'PAID')
        )
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

COMMENT ON FUNCTION get_invoice_statistics IS
  'Aggregated invoice statistics with filters (building/room/bed/area/status/date_range/billing_month/payment_status). Returns totals, breakdown by item type (rent/electric/water/pdv), payments by method (TM/TK/TT), and change (excess).';
