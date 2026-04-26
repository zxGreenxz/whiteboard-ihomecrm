-- =============================================
-- Migration: recurring income/expense vouchers
-- Mirrors Resident's "Cài đặt lặp lại" feature: a parent voucher carries
-- a chu kỳ + ngày lặp tiếp theo, and we generate child vouchers from it.
-- =============================================

-- 1. Add repeat fields on income_expenses
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_cycle TEXT
  CHECK (repeat_cycle IN ('NONE','WEEK','MONTH','QUARTER','YEAR'))
  DEFAULT 'NONE';
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_infinity BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_next_date DATE;
ALTER TABLE income_expenses ADD COLUMN IF NOT EXISTS repeat_parent_id UUID
  REFERENCES income_expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ie_repeat_next_date
  ON income_expenses(repeat_next_date)
  WHERE repeat_cycle <> 'NONE' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ie_repeat_parent_id
  ON income_expenses(repeat_parent_id) WHERE repeat_parent_id IS NOT NULL;

COMMENT ON COLUMN income_expenses.repeat_cycle IS 'NONE | WEEK | MONTH | QUARTER | YEAR';
COMMENT ON COLUMN income_expenses.repeat_infinity IS 'Lặp vô hạn (bỏ qua repeat_count)';
COMMENT ON COLUMN income_expenses.repeat_count IS 'Số lần lặp tổng';
COMMENT ON COLUMN income_expenses.repeat_remaining IS 'Số lần lặp còn lại';
COMMENT ON COLUMN income_expenses.repeat_next_date IS 'Ngày lặp tiếp theo, dùng để generate phiếu con';
COMMENT ON COLUMN income_expenses.repeat_parent_id IS 'Phiếu cha — phiếu con tham chiếu lên';

-- 2. RPC generate_recurring_vouchers() — sinh phiếu con tới hôm nay
CREATE OR REPLACE FUNCTION generate_recurring_vouchers(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(parent_id UUID, child_id UUID, voucher_date DATE) AS $$
DECLARE
  parent RECORD;
  child_voucher_id UUID;
  next_date DATE;
  iteration INTEGER;
  step_interval INTERVAL;
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_next_date IS NOT NULL
      AND ie.repeat_next_date <= CURRENT_DATE
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_remaining > 0)
  LOOP
    next_date := parent.repeat_next_date;
    iteration := 0;

    -- step interval mapping
    step_interval := CASE parent.repeat_cycle
      WHEN 'WEEK' THEN INTERVAL '7 days'
      WHEN 'MONTH' THEN INTERVAL '1 month'
      WHEN 'QUARTER' THEN INTERVAL '3 months'
      WHEN 'YEAR' THEN INTERVAL '1 year'
      ELSE INTERVAL '0 days'
    END;

    -- Loop generating until next_date > today or remaining hits zero
    WHILE next_date <= CURRENT_DATE
          AND (parent.repeat_infinity OR parent.repeat_remaining - iteration > 0)
          AND iteration < 24 -- safety cap per run
    LOOP
      -- Insert child voucher (clone parent essentials)
      INSERT INTO income_expenses (
        user_id, type, name, building_id, room_id, bed_id, tenant_id,
        contract_id, account_id, payer_name,
        approval_status, business_result_accounting,
        attachments, notes,
        receive_bank_name, receive_bank_account,
        creator_name,
        voucher_date,
        invoice_id,
        repeat_parent_id,
        repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
      ) VALUES (
        parent.user_id, parent.type,
        parent.name || ' (tự động lập)',
        parent.building_id, parent.room_id, parent.bed_id, parent.tenant_id,
        parent.contract_id, parent.account_id, parent.payer_name,
        'APPROVED', parent.business_result_accounting,
        parent.attachments, parent.notes,
        parent.receive_bank_name, parent.receive_bank_account,
        parent.creator_name,
        next_date,
        NULL,
        parent.id,
        'NONE', false, 0, 0
      ) RETURNING id INTO child_voucher_id;

      -- Clone items (ngày start/end = next_date)
      INSERT INTO income_expense_items (
        income_expense_id, income_expense_type_id,
        description, quantity, unit_price,
        start_date, end_date
      )
      SELECT
        child_voucher_id, ii.income_expense_type_id,
        ii.description, ii.quantity, ii.unit_price,
        next_date, next_date
      FROM income_expense_items ii
      WHERE ii.income_expense_id = parent.id;

      RETURN QUERY SELECT parent.id, child_voucher_id, next_date;

      iteration := iteration + 1;
      next_date := (next_date + step_interval)::DATE;
    END LOOP;

    -- Update parent with new next_date and decremented remaining
    UPDATE income_expenses
    SET repeat_next_date = next_date,
        repeat_remaining = CASE
          WHEN parent.repeat_infinity THEN parent.repeat_remaining
          ELSE GREATEST(0, parent.repeat_remaining - iteration)
        END
    WHERE id = parent.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION generate_recurring_vouchers(UUID) TO authenticated;

COMMENT ON FUNCTION generate_recurring_vouchers IS
  'Sinh các phiếu thu/chi con dựa trên các phiếu cha có repeat_cycle <> NONE. Idempotent — chỉ sinh tới CURRENT_DATE.';
