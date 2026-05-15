-- =============================================
-- Migration: QR public chuyển từ "theo phòng" → "theo hợp đồng".
-- - Mỗi hợp đồng có 1 mã QR duy nhất (= contract.id, UUID v4).
-- - Hợp đồng TERMINATED (hoặc soft-deleted) → QR vô hiệu (RPC trả NULL).
-- - Hàm cũ `get_public_latest_invoice_by_room` đã không còn nơi gọi → DROP.
-- =============================================

-- Bỏ RPC cũ (theo phòng).
DROP FUNCTION IF EXISTS public.get_public_latest_invoice_by_room(uuid);

-- RPC mới: lấy hoá đơn mới nhất theo hợp đồng.
CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_contract(
  p_contract_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract RECORD;
  v_invoice_id uuid;
  v_result jsonb;
BEGIN
  -- Hợp đồng phải tồn tại, chưa xoá, và chưa thanh lý.
  -- (building_id resolve qua room.building_id; contracts không có cột này.)
  SELECT id, status, room_id, bed_id, deleted_at
  INTO v_contract
  FROM public.contracts
  WHERE id = p_contract_id;

  IF v_contract.id IS NULL
     OR v_contract.deleted_at IS NOT NULL
     OR v_contract.status = 'TERMINATED' THEN
    RETURN NULL;
  END IF;

  -- Hoá đơn mới nhất của hợp đồng (bỏ DRAFT/CANCELLED).
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE contract_id = p_contract_id
    AND deleted_at IS NULL
    AND status <> 'CANCELLED'
    AND status <> 'DRAFT'
  ORDER BY billing_month DESC, created_at DESC
  LIMIT 1;

  IF v_invoice_id IS NULL THEN
    -- Hợp đồng chưa có hoá đơn → vẫn trả metadata phòng/toà/khách để
    -- public page hiển thị "chưa có hoá đơn".
    SELECT jsonb_build_object(
      'invoice', NULL,
      'room', CASE WHEN r.id IS NOT NULL
        THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
        ELSE NULL END,
      'building', CASE WHEN b.id IS NOT NULL
        THEN jsonb_build_object('id', b.id, 'name', b.name)
        ELSE NULL END,
      'bed', CASE WHEN bd.id IS NOT NULL
        THEN jsonb_build_object('id', bd.id, 'name', bd.name)
        ELSE NULL END,
      'customer', CASE WHEN c.full_name IS NOT NULL
        THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
        ELSE NULL END
    )
    INTO v_result
    FROM public.contracts ct
    LEFT JOIN public.rooms r ON r.id = ct.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
    LEFT JOIN public.beds bd ON bd.id = ct.bed_id
    LEFT JOIN LATERAL (
      SELECT cust.full_name, cust.phone
      FROM public.contract_customers cc
      JOIN public.customers cust ON cust.id = cc.customer_id
      WHERE cc.contract_id = ct.id
      ORDER BY cc.is_representative DESC NULLS LAST
      LIMIT 1
    ) c ON TRUE
    WHERE ct.id = p_contract_id;

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
    'room', CASE WHEN r.id IS NOT NULL
      THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
      ELSE NULL END,
    'building', CASE WHEN b.id IS NOT NULL
      THEN jsonb_build_object('id', b.id, 'name', b.name)
      ELSE NULL END,
    'bed', CASE WHEN bd.id IS NOT NULL
      THEN jsonb_build_object('id', bd.id, 'name', bd.name)
      ELSE NULL END,
    'customer', CASE WHEN c.full_name IS NOT NULL
      THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
      ELSE NULL END
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

COMMENT ON FUNCTION public.get_public_latest_invoice_by_contract(uuid) IS
'Public read API cho khách quét QR theo hợp đồng. Trả NULL nếu hợp đồng đã thanh lý / bị xoá. Bypass RLS có kiểm soát, không expose notes/contract_id/user_id.';

GRANT EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid)
  TO anon, authenticated;
