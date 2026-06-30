-- =============================================
-- Fix bug class: BEFORE INSERT code generators must be SECURITY DEFINER
-- =============================================
-- Root cause (proven): a code-generator trigger that computes the next
-- sequence by reading an RLS-protected table runs under the CALLER's RLS
-- when it is SECURITY INVOKER (the default). Non-admin staff see only the
-- rows of the buildings they are assigned to, so MAX(...)/COUNT(...) is
-- computed over a partial view -> a too-low sequence -> a code that already
-- exists elsewhere -> unique violation -> the insert fails silently for
-- staff while it works for the owner (is_admin, sees all rows).
--
-- Confirmed for meter_readings (CSS reading_code): staff "nathan" saw 8/90
-- CSS2607 rows, generated CSS260700009 which already existed -> 23505 on
-- idx_meter_readings_code.
--
-- Fix: make every affected generator SECURITY DEFINER (so its internal
-- SELECT bypasses RLS and sees the full table) + SET search_path = public
-- (prevents search_path hijacking) + pg_advisory_xact_lock per logical key
-- (serializes concurrent inserts so MAX+1 / COUNT+1 cannot race).
-- Reference correct pattern already in the codebase: generate_job_code().
--
-- Logic is otherwise UNCHANGED. Applied via Management API (ASCII only).
-- =============================================

-- 1) meter_readings.reading_code -- THE reported bug. Keep MAX+lock, add secdef.
CREATE OR REPLACE FUNCTION public.auto_generate_reading_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prefix   TEXT;
  v_next_seq INT;
BEGIN
  IF NEW.reading_code IS NOT NULL AND NEW.reading_code <> '' THEN
    RETURN NEW;
  END IF;

  v_prefix := 'CSS' || TO_CHAR(NEW.reading_date, 'YYMM');

  PERFORM pg_advisory_xact_lock(hashtext(v_prefix));

  SELECT COALESCE(MAX(CAST(substring(reading_code FROM length(v_prefix) + 1) AS INT)), 0) + 1
    INTO v_next_seq
    FROM meter_readings
   WHERE reading_code LIKE v_prefix || '%'
     AND substring(reading_code FROM length(v_prefix) + 1) ~ '^[0-9]+$';

  NEW.reading_code := v_prefix || LPAD(v_next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$function$;

-- 2) material_purchases.code (MP-YYYYMMDD-NNNN) -- GLOBAL unique, staff-reachable.
CREATE OR REPLACE FUNCTION public.set_material_purchase_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_day TEXT;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    v_day := to_char(now(), 'YYYYMMDD');
    PERFORM pg_advisory_xact_lock(hashtext('MP-' || v_day));
    NEW.code := 'MP-' || v_day || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MP-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_purchases
       WHERE code LIKE 'MP-' || v_day || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$function$;

-- 3) material_usages.code (MU-YYYYMMDD-NNNN)
CREATE OR REPLACE FUNCTION public.set_material_usage_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_day TEXT;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    v_day := to_char(now(), 'YYYYMMDD');
    PERFORM pg_advisory_xact_lock(hashtext('MU-' || v_day));
    NEW.code := 'MU-' || v_day || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MU-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_usages
       WHERE code LIKE 'MU-' || v_day || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$function$;

-- 4) material_adjustments.code (MA-YYYYMMDD-NNNN)
CREATE OR REPLACE FUNCTION public.set_material_adjustment_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_day TEXT;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    v_day := to_char(now(), 'YYYYMMDD');
    PERFORM pg_advisory_xact_lock(hashtext('MA-' || v_day));
    NEW.code := 'MA-' || v_day || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MA-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_adjustments
       WHERE code LIKE 'MA-' || v_day || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$function$;

-- 5) income_expenses.code (PT/PC{YYMM}{seq}) -- per-user unique; secdef so the
--    per-user MAX sees ALL of that user's rows even when a staff records it.
CREATE OR REPLACE FUNCTION public.auto_generate_voucher_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prefix TEXT;
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  IF NEW.type = 'INCOME' THEN
    v_prefix := 'PT';
  ELSE
    v_prefix := 'PC';
  END IF;

  v_month := TO_CHAR(CURRENT_DATE, 'YYMM');

  PERFORM pg_advisory_xact_lock(hashtext(v_prefix || v_month || COALESCE(NEW.user_id::text, '')));

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

  NEW.code := v_prefix || v_month || LPAD(v_sequence::TEXT, 3, '0');
  RETURN NEW;
END;
$function$;

-- 6) income_expense_templates.code (MT{YYMM}{seq}) -- per-user; secdef + lock.
CREATE OR REPLACE FUNCTION public.generate_template_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  v_month := TO_CHAR(CURRENT_DATE, 'YYMM');

  PERFORM pg_advisory_xact_lock(hashtext('MT' || v_month || COALESCE(NEW.user_id::text, '')));

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

  NEW.code := 'MT' || v_month || LPAD(v_sequence::TEXT, 3, '0');
  RETURN NEW;
END;
$function$;

-- 7) invoices.invoice_number -- dormant (FE supplies invoice_number) but add
--    secdef + lock as defense-in-depth for the fallback path.
CREATE OR REPLACE FUNCTION public.generate_invoice_number_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prefix TEXT;
  v_counter INTEGER;
  v_new_number TEXT;
BEGIN
  IF NEW.invoice_number IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('INV' || TO_CHAR(NOW(), 'YYYY') || COALESCE(NEW.user_id::text, '')));

    SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
    WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

    IF v_prefix IS NULL THEN
      v_prefix := 'INV';
    END IF;

    SELECT COUNT(*) + 1
    INTO v_counter
    FROM invoices
    WHERE user_id = NEW.user_id
      AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

    v_new_number := v_prefix || '-' ||
                    TO_CHAR(NOW(), 'YYYY') || '-' ||
                    LPAD(v_counter::TEXT, 5, '0');

    NEW.invoice_number := v_new_number;
  END IF;

  RETURN NEW;
END;
$function$;
