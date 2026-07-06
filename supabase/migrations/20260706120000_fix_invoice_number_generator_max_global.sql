-- =============================================
-- Fix: invoice_number generator collides (23505 on invoices_invoice_number_key)
-- =============================================
-- Symptom (proven): terminate_contract_move_out fails with
--   duplicate key value violates unique constraint "invoices_invoice_number_key"
--   Key (invoice_number)=(INV-2026-00295) already exists
--
-- Root cause: invoices_invoice_number_key is a GLOBAL unique constraint
--   (UNIQUE (invoice_number)), but generate_invoice_number_v2() computed the
--   next sequence as COUNT(*) + 1 filtered PER-USER + PER-YEAR. COUNT drifts
--   away from the real max sequence on ANY of:
--     - gaps in the INV sequence (deleted / soft-deleted invoices are counted,
--       or a number was skipped),
--     - invoices with a different number format for the same user (they inflate
--       COUNT but are not part of the INV-YYYY-#### space),
--     - two users sharing the same prefix (per-user COUNT, global constraint).
--   Observed: user has 294 invoices in 2026 (COUNT+1 = 295) while the real max
--   INV-2026 sequence is already 297 -> regenerates INV-2026-00295 -> 23505.
--
-- Fix: compute the sequence with MAX(trailing digits) + 1 over the GLOBAL
--   "<prefix>-<year>-<n>" space (matching the global constraint), guarded by a
--   per prefix+year advisory lock. Same correct pattern as the other generators
--   fixed in 20260701000001_secdef_code_generators.sql.
-- =============================================

CREATE OR REPLACE FUNCTION public.generate_invoice_number_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prefix TEXT;
  v_year   TEXT;
  v_seq    INTEGER;
BEGIN
  IF NEW.invoice_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_year := TO_CHAR(NOW(), 'YYYY');

  SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
   WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'INV';
  END IF;

  -- Serialize concurrent inserts sharing the same prefix+year so MAX+1 cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  -- GLOBAL max over "<prefix>-<year>-<digits>" (constraint is global, not per-user).
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '(\d+)$') AS INTEGER)), 0) + 1
    INTO v_seq
    FROM invoices
   WHERE invoice_number LIKE (v_prefix || '-' || v_year || '-%')
     AND invoice_number ~ ('^' || v_prefix || '-' || v_year || '-\d+$');

  NEW.invoice_number := v_prefix || '-' || v_year || '-' || LPAD(v_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$function$;
