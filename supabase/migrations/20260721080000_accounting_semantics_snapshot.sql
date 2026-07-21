-- Structured accounting semantics for invoice and ledger lines.
--
-- ROLLBACK (manual, only before v2/v5 writers are enabled): restore the prior
-- recompute/report functions, drop the two snapshot triggers, then drop the
-- accounting_class columns and constraints. Do not drop after new rows exist.

BEGIN;

-- Canonical IE rows are intentionally immutable to application writers. A
-- schema backfill is the only exception; disable the two payload guards only
-- inside this transaction and restore them before commit.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expense_items'::regclass
      AND tgname = 'a00_ie_item_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expense_items
      DISABLE TRIGGER a00_ie_item_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'a00_ie_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      DISABLE TRIGGER a00_ie_owned_payload_freeze;
  END IF;
END;
$$;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS accounting_class text;

UPDATE public.invoice_items
SET accounting_class = CASE
  WHEN type::text = 'OTHER' AND lower(btrim(description)) = 'tiền cọc' THEN 'DEPOSIT'
  ELSE 'REVENUE'
END
WHERE accounting_class IS NULL;

ALTER TABLE public.invoice_items
  ALTER COLUMN accounting_class SET DEFAULT 'REVENUE',
  ALTER COLUMN accounting_class SET NOT NULL;

ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS invoice_items_accounting_class_check;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_accounting_class_check
  CHECK (accounting_class IN ('REVENUE', 'DEPOSIT', 'NON_PNL'));

COMMENT ON COLUMN public.invoice_items.accounting_class IS
  'Structured accounting meaning. DEPOSIT is a liability and must never be inferred from description text.';

ALTER TABLE public.income_expense_items
  ADD COLUMN IF NOT EXISTS accounting_class text;

UPDATE public.income_expense_items item
SET accounting_class = CASE WHEN type_row.is_deposit THEN 'DEPOSIT' ELSE 'PNL' END
FROM public.income_expense_types type_row
WHERE type_row.id = item.income_expense_type_id
  AND item.accounting_class IS NULL;

-- Defensive fallback for legacy rows whose type was removed or is not visible.
UPDATE public.income_expense_items
SET accounting_class = 'PNL'
WHERE accounting_class IS NULL;

ALTER TABLE public.income_expense_items
  ALTER COLUMN accounting_class SET NOT NULL;

ALTER TABLE public.income_expense_items
  DROP CONSTRAINT IF EXISTS income_expense_items_accounting_class_check;
ALTER TABLE public.income_expense_items
  ADD CONSTRAINT income_expense_items_accounting_class_check
  CHECK (accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT', 'INTERNAL'));

COMMENT ON COLUMN public.income_expense_items.accounting_class IS
  'Snapshot accounting class at posting time. PNL counts in business result; DEPOSIT/CUSTOMER_CREDIT/INTERNAL do not unless the voucher explicitly overrides TRUE.';

CREATE OR REPLACE FUNCTION public.set_ie_item_accounting_class()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_deposit boolean;
BEGIN
  IF NEW.accounting_class IS NULL
     OR (
       TG_OP = 'UPDATE'
       AND NEW.income_expense_type_id IS DISTINCT FROM OLD.income_expense_type_id
       AND NEW.accounting_class IS NOT DISTINCT FROM OLD.accounting_class
       AND OLD.accounting_class IN ('PNL', 'DEPOSIT')
     ) THEN
    SELECT t.is_deposit
      INTO v_is_deposit
      FROM public.income_expense_types t
     WHERE t.id = NEW.income_expense_type_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown income_expense_type_id %', NEW.income_expense_type_id
        USING ERRCODE = '23503';
    END IF;

    NEW.accounting_class := CASE WHEN v_is_deposit THEN 'DEPOSIT' ELSE 'PNL' END;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_ie_item_accounting_class() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_ie_item_accounting_class ON public.income_expense_items;
CREATE TRIGGER set_ie_item_accounting_class
BEFORE INSERT OR UPDATE OF income_expense_type_id, accounting_class
ON public.income_expense_items
FOR EACH ROW EXECUTE FUNCTION public.set_ie_item_accounting_class();

CREATE OR REPLACE FUNCTION public.recompute_ie_business_result(p_ie_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override       boolean;
  v_total          numeric;
  v_item_count     integer;
  v_pnl_sum        numeric;
  v_has_deposit    boolean;
  v_has_restricted boolean;
  v_result         boolean;
  v_kqkd           numeric;
BEGIN
  SELECT business_result_accounting, COALESCE(total_amount, 0)
    INTO v_override, v_total
    FROM public.income_expenses
   WHERE id = p_ie_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*),
    COALESCE(SUM(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(bool_or(item.accounting_class = 'DEPOSIT'), false),
    COALESCE(bool_or(type_row.is_restricted), false)
  INTO v_item_count, v_pnl_sum, v_has_deposit, v_has_restricted
  FROM public.income_expense_items item
  LEFT JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE item.income_expense_id = p_ie_id;

  v_kqkd := CASE
    WHEN v_override IS TRUE THEN v_total
    WHEN v_override IS FALSE THEN 0
    WHEN v_item_count = 0 THEN v_total
    ELSE GREATEST(LEAST(v_pnl_sum, v_total), 0)
  END;
  v_result := v_kqkd > 0;

  UPDATE public.income_expenses
     SET counts_in_business_result = v_result,
         has_restricted_item = v_has_restricted,
         kqkd_amount = v_kqkd
   WHERE id = p_ie_id
     AND (
       counts_in_business_result IS DISTINCT FROM v_result
       OR has_restricted_item IS DISTINCT FROM v_has_restricted
       OR kqkd_amount IS DISTINCT FROM v_kqkd
     );
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_ie_business_result(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric(15,2) := 0;
  v_count_any integer := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(
      CASE WHEN voucher.type = 'EXPENSE' THEN -1 ELSE 1 END
      * COALESCE(item.amount, item.unit_price * item.quantity)
    ) FILTER (
      WHERE voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL
    ), 0),
    COUNT(*)
  INTO v_total, v_count_any
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
   AND item.accounting_class = 'DEPOSIT'
  WHERE voucher.contract_id = p_contract_id;

  IF v_count_any > 0 THEN
    UPDATE public.contracts
       SET deposit_paid = GREATEST(v_total, 0),
           updated_at = now()
     WHERE id = p_contract_id
       AND deleted_at IS NULL
       AND deposit_paid IS DISTINCT FROM GREATEST(v_total, 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_contract_deposit_paid(uuid) FROM PUBLIC, anon, authenticated;

-- Recompute all materialized P&L values from the new snapshot class.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.income_expenses LOOP
    PERFORM public.recompute_ie_business_result(r.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fa_type_breakdown(
  p_start_date date,
  p_end_date date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month date,
  side text,
  type_id uuid,
  type_name text,
  category text,
  total_amount numeric,
  voucher_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  base AS (
    SELECT voucher.id, voucher.type, voucher.total_amount,
           voucher.business_result_accounting AS override,
           date_trunc('month', voucher.voucher_date)::date AS m
    FROM public.income_expenses voucher
    JOIN allowed a ON a.id = voucher.building_id
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
      AND voucher.voucher_date BETWEEN p_start_date AND p_end_date
  )
  SELECT base.m, base.type::text, type_row.id, type_row.name, type_row.category,
         SUM(COALESCE(item.amount, item.unit_price * item.quantity))::numeric,
         COUNT(DISTINCT base.id)
  FROM base
  JOIN public.income_expense_items item ON item.income_expense_id = base.id
  JOIN public.income_expense_types type_row ON type_row.id = item.income_expense_type_id
  WHERE base.override IS TRUE OR item.accounting_class = 'PNL'
  GROUP BY base.m, base.type, type_row.id, type_row.name, type_row.category
  UNION ALL
  SELECT base.m, base.type::text, NULL::uuid, 'Không có hạng mục'::text, NULL::text,
         SUM(base.total_amount)::numeric, COUNT(*)
  FROM base
  WHERE NOT EXISTS (
    SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = base.id
  )
  GROUP BY base.m, base.type
  ORDER BY 1, 2, 6 DESC;
$$;

CREATE OR REPLACE FUNCTION public.fa_accrual_allocations(
  p_start_date date,
  p_end_date date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month date,
  voucher_id uuid,
  building_id uuid,
  building_name text,
  is_virtual boolean,
  side text,
  type_id uuid,
  type_name text,
  category text,
  amount numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name, b.is_virtual
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  win AS (
    SELECT date_trunc('month', p_start_date)::date AS w_start,
           date_trunc('month', p_end_date)::date AS w_end
  ),
  vouchers AS (
    SELECT voucher.id, voucher.type::text AS side, voucher.voucher_date,
           allowed.id AS bid, allowed.name AS bname, allowed.is_virtual,
           voucher.total_amount, voucher.business_result_accounting AS override,
           CASE
             WHEN voucher.invoice_id IS NOT NULL AND invoice.billing_month ~ '^\d{4}-\d{2}$'
             THEN to_date(invoice.billing_month, 'YYYY-MM')
           END AS inv_month
    FROM allowed
    JOIN public.income_expenses voucher ON voucher.building_id = allowed.id
    LEFT JOIN public.invoices invoice
      ON invoice.id = voucher.invoice_id AND invoice.deleted_at IS NULL
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
  ),
  invoice_items AS (
    SELECT vouchers.inv_month AS m, vouchers.id, vouchers.bid, vouchers.bname,
           vouchers.is_virtual, vouchers.side, type_row.id AS tid,
           type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_row ON type_row.id = item.income_expense_type_id
    WHERE vouchers.inv_month IS NOT NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT vouchers.inv_month AS m, vouchers.id, vouchers.bid, vouchers.bname,
           vouchers.is_virtual, vouchers.side, NULL::uuid AS tid,
           'Không có hạng mục'::text AS tname, NULL::text AS category,
           vouchers.total_amount AS amt
    FROM vouchers
    WHERE vouchers.inv_month IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = vouchers.id
      )
  ),
  period_items AS (
    SELECT (date_trunc('month', item.start_date) + (series.i || ' month')::interval)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           (round(COALESCE(item.amount, item.unit_price * item.quantity) * (series.i + 1) / count_months.n)
            - round(COALESCE(item.amount, item.unit_price * item.quantity) * series.i / count_months.n))::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_row ON type_row.id = item.income_expense_type_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        extract(year FROM item.end_date)::int * 12 + extract(month FROM item.end_date)::int
        - extract(year FROM item.start_date)::int * 12 - extract(month FROM item.start_date)::int + 1,
        1
      ) AS n
    ) count_months
    CROSS JOIN LATERAL generate_series(0, count_months.n - 1) AS series(i)
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date >= item.start_date
  ),
  invalid_period_items AS (
    SELECT date_trunc('month', item.start_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_row ON type_row.id = item.income_expense_type_id
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date < item.start_date
  ),
  no_period_items AS (
    SELECT date_trunc('month', vouchers.voucher_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_row ON type_row.id = item.income_expense_type_id
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND (item.start_date IS NULL OR item.end_date IS NULL)
  ),
  no_item AS (
    SELECT date_trunc('month', vouchers.voucher_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           NULL::uuid AS tid, 'Không có hạng mục'::text AS tname,
           NULL::text AS category, vouchers.total_amount AS amt
    FROM vouchers
    WHERE vouchers.inv_month IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = vouchers.id
      )
  ),
  unioned AS (
    SELECT * FROM invoice_items
    UNION ALL SELECT * FROM invoice_no_item
    UNION ALL SELECT * FROM period_items
    UNION ALL SELECT * FROM invalid_period_items
    UNION ALL SELECT * FROM no_period_items
    UNION ALL SELECT * FROM no_item
  )
  SELECT unioned.m, unioned.id, unioned.bid, unioned.bname, unioned.is_virtual,
         unioned.side, unioned.tid, unioned.tname, unioned.category, unioned.amt
  FROM unioned, win
  WHERE unioned.m BETWEEN win.w_start AND win.w_end;
$$;

COMMENT ON FUNCTION public.fa_accrual_allocations(date, date, uuid[]) IS
  'Canonical re-perioded ledger allocations using immutable item accounting_class snapshots.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expense_items'::regclass
      AND tgname = 'a00_ie_item_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expense_items
      ENABLE TRIGGER a00_ie_item_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'a00_ie_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      ENABLE TRIGGER a00_ie_owned_payload_freeze;
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
