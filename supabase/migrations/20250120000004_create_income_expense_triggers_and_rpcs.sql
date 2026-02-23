-- =============================================
-- Migration: Create triggers and RPC functions for income/expense module
-- Description: Auto-generate voucher codes, auto-calculate amounts, auto-update timestamps,
--              and RPC functions for approve/unapprove vouchers
-- Requirements: 1.6, 2.2, 4.2, 4.3, 11.6, 11.8
-- =============================================


-- =============================================
-- 1. AUTO-GENERATE VOUCHER CODE
-- Format: PT{YYMM}{seq} for INCOME, PC{YYMM}{seq} for EXPENSE
-- seq is 3-digit zero-padded, per user per month per type
-- Examples: PT2507001, PC2507002
-- =============================================

CREATE OR REPLACE FUNCTION auto_generate_voucher_code()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  -- Only generate if code is empty
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  -- Determine prefix based on type
  IF NEW.type = 'INCOME' THEN
    v_prefix := 'PT';
  ELSE
    v_prefix := 'PC';
  END IF;

  -- Get current YYMM
  v_month := TO_CHAR(CURRENT_DATE, 'YYMM');

  -- Get next sequence for this user, month, and type
  SELECT COALESCE(MAX(
    CASE
      WHEN code ~ ('^' || v_prefix || '\d{4}\d+$')
        AND SUBSTRING(code FROM 3 FOR 4) = v_month
      THEN CAST(SUBSTRING(code FROM 7) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_sequence
  FROM income_expenses
  WHERE user_id = NEW.user_id
    AND type = NEW.type
    AND code LIKE v_prefix || v_month || '%';

  -- Generate code: prefix + YYMM + 3-digit sequence
  NEW.code := v_prefix || v_month || LPAD(v_sequence::TEXT, 3, '0');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_generate_voucher_code
  BEFORE INSERT ON income_expenses
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_voucher_code();

COMMENT ON FUNCTION auto_generate_voucher_code() IS
'Auto-generates voucher code: PT{YYMM}{seq} for INCOME, PC{YYMM}{seq} for EXPENSE';


-- =============================================
-- 2. AUTO-CALCULATE ITEM AMOUNT
-- amount = quantity * unit_price on INSERT/UPDATE income_expense_items
-- =============================================

CREATE OR REPLACE FUNCTION auto_calc_item_amount()
RETURNS TRIGGER AS $$
BEGIN
  NEW.amount := NEW.quantity * NEW.unit_price;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_calc_item_amount
  BEFORE INSERT OR UPDATE ON income_expense_items
  FOR EACH ROW
  EXECUTE FUNCTION auto_calc_item_amount();

COMMENT ON FUNCTION auto_calc_item_amount() IS
'Auto-calculates item amount = quantity * unit_price';


-- =============================================
-- 3. AUTO-RECALCULATE TOTAL AMOUNT
-- Recalculates parent income_expenses.total_amount = SUM(items.amount)
-- on INSERT/UPDATE/DELETE income_expense_items
-- =============================================

CREATE OR REPLACE FUNCTION auto_recalc_total_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_id UUID;
  v_total DECIMAL(15, 2);
BEGIN
  -- Determine the parent voucher id
  IF TG_OP = 'DELETE' THEN
    v_parent_id := OLD.income_expense_id;
  ELSE
    v_parent_id := NEW.income_expense_id;
  END IF;

  -- Calculate new total from all items
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total
  FROM income_expense_items
  WHERE income_expense_id = v_parent_id;

  -- Update parent voucher
  UPDATE income_expenses
  SET total_amount = v_total
  WHERE id = v_parent_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_recalc_total_amount
  AFTER INSERT OR UPDATE OR DELETE ON income_expense_items
  FOR EACH ROW
  EXECUTE FUNCTION auto_recalc_total_amount();

COMMENT ON FUNCTION auto_recalc_total_amount() IS
'Auto-recalculates parent voucher total_amount = SUM(items.amount)';


-- =============================================
-- 4. AUTO-UPDATE UPDATED_AT
-- Reuses existing update_updated_at_column() function from 008_triggers_functions.sql
-- Applied to income_expenses and income_expense_templates
-- =============================================

CREATE TRIGGER set_income_expenses_updated_at
  BEFORE UPDATE ON income_expenses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_income_expense_templates_updated_at
  BEFORE UPDATE ON income_expense_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 5. GENERATE TEMPLATE CODE
-- Auto-generates code for income_expense_templates on INSERT
-- Format: MT{YYMM}{seq} - 3-digit zero-padded sequence per user per month
-- =============================================

CREATE OR REPLACE FUNCTION generate_template_code()
RETURNS TRIGGER AS $$
DECLARE
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  -- Only generate if code is empty
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  -- Get current YYMM
  v_month := TO_CHAR(CURRENT_DATE, 'YYMM');

  -- Get next sequence for this user and month
  SELECT COALESCE(MAX(
    CASE
      WHEN code ~ ('^MT\d{4}\d+$')
        AND SUBSTRING(code FROM 3 FOR 4) = v_month
      THEN CAST(SUBSTRING(code FROM 7) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_sequence
  FROM income_expense_templates
  WHERE user_id = NEW.user_id
    AND code LIKE 'MT' || v_month || '%';

  -- Generate code: MT + YYMM + 3-digit sequence
  NEW.code := 'MT' || v_month || LPAD(v_sequence::TEXT, 3, '0');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_template_code
  BEFORE INSERT ON income_expense_templates
  FOR EACH ROW
  EXECUTE FUNCTION generate_template_code();

COMMENT ON FUNCTION generate_template_code() IS
'Auto-generates template code in format MT{YYMM}{seq}';


-- =============================================
-- 6. RPC: APPROVE VOUCHER
-- Sets approval_status='APPROVED', approved_by=auth.uid(), approved_at=now()
-- Only for vouchers owned by the current user
-- =============================================

CREATE OR REPLACE FUNCTION approve_voucher(voucher_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE income_expenses
  SET
    approval_status = 'APPROVED',
    approved_by = auth.uid(),
    approved_at = NOW()
  WHERE id = voucher_id
    AND user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION approve_voucher(UUID) IS
'Approves an income/expense voucher - sets status to APPROVED with approver info';


-- =============================================
-- 7. RPC: UNAPPROVE VOUCHER
-- Sets approval_status='UNAPPROVED', clears approved_by and approved_at
-- Only for vouchers owned by the current user
-- =============================================

CREATE OR REPLACE FUNCTION unapprove_voucher(voucher_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE income_expenses
  SET
    approval_status = 'UNAPPROVED',
    approved_by = NULL,
    approved_at = NULL
  WHERE id = voucher_id
    AND user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION unapprove_voucher(UUID) IS
'Unapproves an income/expense voucher - resets status to UNAPPROVED and clears approver info';


-- =============================================
-- Migration completed
-- =============================================
-- Functions created: 5 (auto_generate_voucher_code, auto_calc_item_amount,
--   auto_recalc_total_amount, generate_template_code, approve_voucher, unapprove_voucher)
-- Triggers created: 5 (voucher_code, item_amount, recalc_total, updated_at x2, template_code)
-- RPC functions: 2 (approve_voucher, unapprove_voucher)
-- Reused: update_updated_at_column() from 008_triggers_functions.sql
