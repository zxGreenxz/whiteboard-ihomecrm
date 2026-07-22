-- §B7 server-side fail-closed gate for customer credit forward-apply.
--
-- The V5 client already blocks overpay_action=CREDIT while customer.credit.apply.v1
-- is not CANONICAL (Phase 4). This is the defense-in-depth SERVER half required by
-- PLAN §0.7/§B7: a direct RPC call or an old client must NOT be able to mint a new
-- customer credit lot (forward credit) while the credit-apply feature is off.
--
-- Mechanism: a BEFORE INSERT trigger on public.customer_credit_lots that fails
-- closed (55000) unless customer.credit.apply.v1 evaluates CANONICAL for the lot's
-- organization. Because record_invoice_collection_v5 mints the lot inside its own
-- transaction, the RAISE aborts the whole collection — no lot, no collection.
--
-- Scope-safe:
--   * Only affects NEW inserts; existing lots are untouched.
--   * customer.credit.reverse.v1 (ON) operates on existing lots via UPDATE, so
--     historical credit reversal keeps working.
--   * Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS), forward-only.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.guard_customer_credit_apply_gate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $guard_customer_credit_apply_gate_v1$
DECLARE
  v_route text;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'customer credit lot thiếu organization_id' USING ERRCODE = '55000';
  END IF;

  v_route := app_private.evaluate_feature_route('customer.credit.apply.v1', NEW.organization_id);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'Tính năng giữ tiền thừa làm credit khách hàng chưa được bật (route=%); không thể tạo credit lot mới',
      v_route
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$guard_customer_credit_apply_gate_v1$;

REVOKE ALL ON FUNCTION app_private.guard_customer_credit_apply_gate_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS a05_customer_credit_apply_gate ON public.customer_credit_lots;
CREATE TRIGGER a05_customer_credit_apply_gate
  BEFORE INSERT ON public.customer_credit_lots
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_customer_credit_apply_gate_v1();

COMMIT;

NOTIFY pgrst, 'reload schema';
