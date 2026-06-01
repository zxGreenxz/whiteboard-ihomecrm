-- =============================================
-- Migration: Gỡ bỏ HOÀN TOÀN "thuế" khỏi hệ thống (theo yêu cầu).
-- - Bỏ thuế hoá đơn: invoices.tax_percent, invoices.tax_amount.
-- - Bỏ thuế suất dịch vụ: services.tax_rate.
-- - Bỏ mã số thuế khách tổ chức: customers.tax_code.
-- Dữ liệu thực tế: 0/548 hoá đơn có thuế ≠ 0, 0/32 dịch vụ có tax_rate ≠ 0
--   → drop an toàn, total_amount không đổi (total_amount tính ở app layer,
--   remaining_amount generated chỉ tham chiếu total_amount).
-- Chỉ 1 RPC tham chiếu cột thuế: get_public_latest_invoice_by_contract
--   (nhúng 'tax_amount' vào jsonb) → recreate trước khi DROP.
-- File khôi phục chi tiết: morong.md (root repo).
-- =============================================

-- 1) Recreate RPC public (QR hợp đồng) — BỎ dòng 'tax_amount', i.tax_amount.
--    Giữ nguyên signature + grant để PostgREST không đổi. by_code gọi nội bộ
--    hàm này nên cũng được vá theo.
CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_contract(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_invoice_id uuid;
  v_result jsonb;
BEGIN
  -- Hợp đồng phải tồn tại, chưa xoá, và chưa thanh lý.
  SELECT id, status, room_id, deleted_at
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
    SELECT jsonb_build_object(
      'invoice', NULL,
      'room', CASE WHEN r.id IS NOT NULL
        THEN jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code)
        ELSE NULL END,
      'building', CASE WHEN b.id IS NOT NULL
        THEN jsonb_build_object('id', b.id, 'name', b.name)
        ELSE NULL END,
      'bed', NULL,
      'customer', CASE WHEN c.full_name IS NOT NULL
        THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
        ELSE NULL END
    )
    INTO v_result
    FROM public.contracts ct
    LEFT JOIN public.rooms r ON r.id = ct.room_id
    LEFT JOIN public.buildings b ON b.id = r.building_id
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
    'bed', NULL,
    'customer', CASE WHEN c.full_name IS NOT NULL
      THEN jsonb_build_object('full_name', c.full_name, 'phone', c.phone)
      ELSE NULL END
  )
  INTO v_result
  FROM public.invoices i
  LEFT JOIN public.rooms r ON r.id = i.room_id
  LEFT JOIN public.buildings b ON b.id = i.building_id
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid)
  TO anon, authenticated;

-- 2) Gỡ ràng buộc thuế cũ (nếu còn sót từ migration 005) rồi DROP cột thuế.
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_tax_non_negative;
ALTER TABLE public.invoices  DROP COLUMN IF EXISTS tax_amount;
ALTER TABLE public.invoices  DROP COLUMN IF EXISTS tax_percent;
ALTER TABLE public.services  DROP COLUMN IF EXISTS tax_rate;
ALTER TABLE public.customers DROP COLUMN IF EXISTS tax_code;
