-- =============================================
-- Migration: public RPC để khách quét QR xem hoá đơn mới nhất của phòng
-- - Function `get_public_latest_invoice_by_room(uuid)` trả jsonb chứa:
--   thông tin phòng, toà, kỳ thanh toán, các khoản thu, tổng tiền…
-- - SECURITY DEFINER để bypass RLS có kiểm soát (chỉ expose data an toàn cho
--   khách thuê: KHÔNG trả notes nội bộ, contract_id, user_id, audit log).
-- - Bỏ qua hoá đơn CANCELLED / DRAFT; chọn theo billing_month DESC.
-- - GRANT cho anon (khách chưa đăng nhập quét QR) và authenticated.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_room(
  p_room_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id uuid;
  v_result jsonb;
BEGIN
  -- Tìm hoá đơn mới nhất (theo kỳ thanh toán) chưa bị xoá / huỷ.
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE room_id = p_room_id
    AND deleted_at IS NULL
    AND status <> 'CANCELLED'
    AND status <> 'DRAFT'
  ORDER BY billing_month DESC, created_at DESC
  LIMIT 1;

  IF v_invoice_id IS NULL THEN
    -- Trả về metadata phòng (nếu có) để public page hiển thị thông báo
    -- "chưa có hoá đơn" thay vì 404.
    SELECT jsonb_build_object(
      'invoice', NULL,
      'room', CASE WHEN r.id IS NOT NULL
        THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
        ELSE NULL
      END,
      'building', CASE WHEN b.id IS NOT NULL
        THEN jsonb_build_object('id', b.id, 'name', b.name)
        ELSE NULL
      END
    )
    INTO v_result
    FROM public.rooms r
    LEFT JOIN public.buildings b ON b.id = r.building_id
    WHERE r.id = p_room_id
      AND r.deleted_at IS NULL;

    RETURN v_result;
  END IF;

  SELECT jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', i.id,
      'invoice_number', i.invoice_number,
      'billing_month', i.billing_month,
      'issue_date', i.issue_date,
      'due_date', i.due_date,
      'status', i.status,
      'subtotal', i.subtotal,
      'discount_amount', i.discount_amount,
      'tax_amount', i.tax_amount,
      'total_amount', i.total_amount,
      'paid_amount', i.paid_amount,
      'remaining_amount', i.remaining_amount,
      'previous_debt', i.previous_debt,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', it.id,
          'type', it.type,
          'description', it.description,
          'unit_price', it.unit_price,
          'quantity', it.quantity,
          'coefficient', it.coefficient,
          'amount', it.amount,
          'previous_reading', it.previous_reading,
          'current_reading', it.current_reading,
          'from_date', it.from_date,
          'to_date', it.to_date
        ) ORDER BY it.sort_order NULLS LAST, it.created_at)
        FROM public.invoice_items it
        WHERE it.invoice_id = i.id
      ), '[]'::jsonb)
    ),
    'room', jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'code', r.code
    ),
    'building', CASE WHEN b.id IS NOT NULL
      THEN jsonb_build_object('id', b.id, 'name', b.name)
      ELSE NULL
    END,
    'bed', CASE WHEN bd.id IS NOT NULL
      THEN jsonb_build_object('id', bd.id, 'name', bd.name)
      ELSE NULL
    END,
    'customer', CASE WHEN c.full_name IS NOT NULL
      THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
      ELSE NULL
    END
  )
  INTO v_result
  FROM public.invoices i
  LEFT JOIN public.rooms r ON r.id = i.room_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
  LEFT JOIN public.beds bd ON bd.id = i.bed_id
  LEFT JOIN LATERAL (
    SELECT cust.full_name, cust.phone
    FROM public.contract_customers cc
    JOIN public.customers cust ON cust.id = cc.customer_id
    WHERE cc.contract_id = i.contract_id
    ORDER BY cc.is_representative DESC NULLS LAST
    LIMIT 1
  ) c ON TRUE
  WHERE i.id = v_invoice_id;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_public_latest_invoice_by_room(uuid) IS
'Public read API cho khách quét QR phòng. Trả về hoá đơn mới nhất (không gồm DRAFT/CANCELLED) + thông tin phòng/toà/khách. Bypass RLS có kiểm soát, không expose notes nội bộ.';

GRANT EXECUTE ON FUNCTION public.get_public_latest_invoice_by_room(uuid)
  TO anon, authenticated;
