-- =============================================
-- Invoice default status: DRAFT -> APPROVED
-- =============================================
-- Lý do: user yêu cầu hoá đơn tạo ra phải mặc định là "đã duyệt" (chính thức),
-- không phải "Nháp". Có 2 path tạo invoice:
--   1) useCreateInvoice (manual) — đã set 'APPROVED' (client-side)
--   2) RPC generate_invoices_for_building (Sinh hoá đơn) — hardcode 'DRAFT' ❌
-- Migration này:
--   a) Sửa RPC để INSERT 'APPROVED' + approved_at + approved_by
--   b) Bulk UPDATE các DRAFT cũ -> APPROVED (kèm approved_at = NOW(), approved_by = user_id)
--      để user có thể "Ghi nhận thanh toán" trên các hoá đơn đã sinh trước đây.

-- ---------------------------------------------
-- (a) Recreate RPC với status = APPROVED
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION generate_invoices_for_building(
  p_user_id UUID,
  p_building_id UUID,
  p_billing_month TEXT,
  p_invoice_type TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_contract RECORD;
  v_service RECORD;
  v_invoice_id UUID;
  v_created_count INT := 0;
  v_skipped_contracts JSON[] := ARRAY[]::JSON[];
  v_subtotal DECIMAL(15, 2);
  v_item_amount DECIMAL(15, 2);
  v_sort_order INT;
BEGIN
  IF p_invoice_type NOT IN ('rent_only', 'service_only', 'both') THEN
    RAISE EXCEPTION 'Invalid invoice_type: %. Must be rent_only, service_only, or both', p_invoice_type;
  END IF;

  IF p_billing_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid billing_month format: %. Must be YYYY-MM', p_billing_month;
  END IF;

  FOR v_contract IN
    SELECT c.id AS contract_id, c.user_id, c.room_id, c.bed_id, c.rent_price, r.building_id
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id
    WHERE c.user_id = p_user_id
      AND r.building_id = p_building_id
      AND c.status = 'ACTIVE'
      AND c.deleted_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM invoices
      WHERE contract_id = v_contract.contract_id
        AND billing_month = p_billing_month
        AND deleted_at IS NULL
    ) THEN
      v_skipped_contracts := array_append(
        v_skipped_contracts,
        json_build_object('contract_id', v_contract.contract_id, 'reason', 'Invoice already exists')
      );
      CONTINUE;
    END IF;

    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, approved_at, approved_by,
      subtotal, total_amount
    ) VALUES (
      p_user_id, v_contract.contract_id, v_contract.building_id,
      v_contract.room_id, v_contract.bed_id,
      p_billing_month, CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
      'APPROVED', NOW(), p_user_id,
      0, 0
    )
    RETURNING id INTO v_invoice_id;

    v_subtotal := 0;
    v_sort_order := 0;

    IF p_invoice_type IN ('rent_only', 'both') THEN
      v_item_amount := v_contract.rent_price;
      v_sort_order := v_sort_order + 1;

      INSERT INTO invoice_items (
        invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order
      ) VALUES (
        v_invoice_id, 'RENT', 'Tiền thuê phòng',
        v_contract.rent_price, 1, 1, v_item_amount, v_sort_order
      );

      v_subtotal := v_subtotal + v_item_amount;
    END IF;

    IF p_invoice_type IN ('service_only', 'both') THEN
      FOR v_service IN
        SELECT cs.service_id, cs.unit_price, s.name AS service_name, s.type AS service_type
        FROM contract_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.contract_id = v_contract.contract_id
      LOOP
        v_sort_order := v_sort_order + 1;
        v_item_amount := v_service.unit_price;

        INSERT INTO invoice_items (
          invoice_id, service_id, type, description,
          unit_price, quantity, coefficient, amount, sort_order
        ) VALUES (
          v_invoice_id, v_service.service_id, 'SERVICE', v_service.service_name,
          v_service.unit_price, 1, 1, v_item_amount, v_sort_order
        );

        v_subtotal := v_subtotal + v_item_amount;
      END LOOP;
    END IF;

    UPDATE invoices
    SET subtotal = v_subtotal, total_amount = v_subtotal
    WHERE id = v_invoice_id;

    v_created_count := v_created_count + 1;
  END LOOP;

  RETURN json_build_object(
    'created_count', v_created_count,
    'skipped_contracts', to_json(v_skipped_contracts)
  );
END;
$BODY$;

COMMENT ON FUNCTION generate_invoices_for_building IS
  'Generate invoices for all active contracts in a building for a given billing month. Defaults to APPROVED status.';

-- ---------------------------------------------
-- (b) Bulk-approve các DRAFT cũ
-- ---------------------------------------------
UPDATE invoices
SET status      = 'APPROVED',
    approved_at = COALESCE(approved_at, NOW()),
    approved_by = COALESCE(approved_by, user_id)
WHERE status = 'DRAFT'
  AND deleted_at IS NULL;
