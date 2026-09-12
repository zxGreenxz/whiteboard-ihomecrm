BEGIN;

-- A shared trigger has a different OLD/NEW record type for each table.
-- SQL AND conditions do not protect references to fields absent from that
-- record: PostgreSQL resolves them before evaluating the condition (42703).
-- Keep table/operation dispatch in separate PL/pgSQL statements.
CREATE OR REPLACE FUNCTION public.guard_paid_invoice_direct_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_TABLE_NAME = 'invoices' THEN
      IF TG_OP = 'UPDATE' THEN
        IF COALESCE(OLD.paid_amount, 0) > 0
          AND (NEW.total_amount IS DISTINCT FROM OLD.total_amount
            OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
            OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
            OR NEW.previous_debt IS DISTINCT FROM OLD.previous_debt) THEN
          RAISE EXCEPTION 'Hoá đơn đã thu tiền chỉ được điều chỉnh qua RPC' USING ERRCODE = '42501';
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'invoice_items' THEN
      -- Check both parents when moving a line: changing invoice_id must not
      -- remove a line from a paid invoice or add one to a paid invoice.
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        IF EXISTS (SELECT 1 FROM public.invoices i
          WHERE i.id = OLD.invoice_id AND COALESCE(i.paid_amount, 0) > 0) THEN
          RAISE EXCEPTION 'Dòng hoá đơn đã thu tiền là bất biến' USING ERRCODE = '42501';
        END IF;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        IF EXISTS (SELECT 1 FROM public.invoices i
          WHERE i.id = NEW.invoice_id AND COALESCE(i.paid_amount, 0) > 0) THEN
          RAISE EXCEPTION 'Dòng hoá đơn đã thu tiền là bất biến' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

COMMIT;
