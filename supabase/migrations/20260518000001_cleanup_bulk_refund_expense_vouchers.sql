-- =============================================
-- Migration: dọn dẹp phiếu chi "Tiền thối hoá đơn ..." lẻ do
-- BulkRecordPaymentDialog tạo trước fix.
--
-- Sai sót cũ: bulk modal tạo phiếu chi EXPENSE với account_id = sổ "X Thối"
-- → gây tồn quỹ âm cho sổ Thối + danh sách thu chi của sổ Thối toàn phiếu
-- chi lẻ thay vì đóng vai trò "ví audit" thuần qua change_account_id metadata
-- (giống single payment).
--
-- Cách sửa: cho mỗi phiếu chi thối lẻ, tìm INCOME voucher phù hợp (cùng
-- invoice_id, cùng voucher_date, link tới payment có amount >= refund —
-- ưu tiên payment_method='TM'); khấu trừ refund vào payment + item của
-- INCOME đó; gắn metadata change_amount/change_account_id + notes; soft-
-- delete phiếu chi lẻ. Nếu không tìm được phiếu thu phù hợp thì chỉ soft-
-- delete (trigger recompute_invoice_for_id tự cập nhật paid_amount).
-- =============================================

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_income_id UUID;
  v_payment_id UUID;
  v_payment_amount NUMERIC;
  v_item_id UUID;
  v_existing_notes TEXT;
  v_gross_str TEXT;
  v_refund_str TEXT;
  v_refund_note TEXT;
  v_composed_notes TEXT;
BEGIN
  FOR r IN
    SELECT ie.id AS refund_id, ie.invoice_id, ie.voucher_date,
           ie.total_amount AS refund_amount, ie.account_id AS refund_account_id
    FROM income_expenses ie
    WHERE ie.type = 'EXPENSE'
      AND ie.name ILIKE 'Tiền thối hoá đơn%'
      AND ie.deleted_at IS NULL
      AND ie.invoice_id IS NOT NULL
  LOOP
    SELECT inc.id,
           p.id,
           p.amount,
           (SELECT id FROM income_expense_items
            WHERE income_expense_id = inc.id
            ORDER BY created_at LIMIT 1),
           inc.notes
    INTO v_income_id, v_payment_id, v_payment_amount, v_item_id, v_existing_notes
    FROM income_expenses inc
    JOIN payments p ON p.id = inc.payment_id
    WHERE inc.invoice_id = r.invoice_id
      AND inc.voucher_date = r.voucher_date
      AND inc.type = 'INCOME'
      AND inc.deleted_at IS NULL
      AND p.amount >= r.refund_amount
    ORDER BY (CASE p.payment_method WHEN 'TM' THEN 0 WHEN 'TK' THEN 1 ELSE 2 END),
             p.amount DESC
    LIMIT 1;

    IF v_income_id IS NOT NULL THEN
      v_gross_str := to_char(v_payment_amount, 'FM999G999G999');
      v_refund_str := to_char(r.refund_amount, 'FM999G999G999');
      v_refund_note := 'Thu ' || v_gross_str || ' – Thối ' || v_refund_str;

      IF v_existing_notes IS NULL OR TRIM(v_existing_notes) = '' THEN
        v_composed_notes := v_refund_note;
      ELSE
        v_composed_notes := TRIM(v_existing_notes) || ' — ' || v_refund_note;
      END IF;

      UPDATE payments
      SET amount = amount - r.refund_amount
      WHERE id = v_payment_id;

      -- Trigger auto_recalc_total_amount sẽ tự update parent.total_amount
      UPDATE income_expense_items
      SET unit_price = unit_price - r.refund_amount
      WHERE id = v_item_id;

      UPDATE income_expenses
      SET change_amount = r.refund_amount,
          change_account_id = r.refund_account_id,
          notes = v_composed_notes
      WHERE id = v_income_id;

      UPDATE income_expenses SET deleted_at = NOW() WHERE id = r.refund_id;
    ELSE
      -- Không tìm được phiếu thu khớp → soft-delete refund (paid_amount tự
      -- recompute qua trigger; nếu mất balance là dữ liệu vốn đã lệch).
      UPDATE income_expenses SET deleted_at = NOW() WHERE id = r.refund_id;
    END IF;
  END LOOP;
END $$;

COMMIT;
