-- =============================================
-- Fix: auto_generate_reading_code must be GLOBALLY unique
-- =============================================
-- Bug: the previous generator numbered the sequence PER-USER
--   (seq = COUNT(*) + 1 WHERE user_id = NEW.user_id), but
--   idx_meter_readings_code is a GLOBAL unique index. Two different
--   owners therefore both produced e.g. CSS260600001 -> unique
--   violation. Callers that ignore the insert error (the Excel
--   invoice dialog) silently lost the meter reading, breaking the
--   month-to-month carry-forward of the electricity index.
--
-- Fix:
--   * Drop the per-user filter -> number GLOBALLY per CSS{YYMM} prefix.
--   * Use MAX(seq)+1 instead of COUNT(*)+1 so soft-deleted / gapped
--     rows can never produce an already-used number.
--   * Take a per-prefix transactional advisory lock so concurrent
--     inserts serialize and cannot compute the same MAX.
--
-- Idempotent (CREATE OR REPLACE). Existing reading_code values are
-- left untouched; new codes simply continue from the global MAX.
-- =============================================

CREATE OR REPLACE FUNCTION public.auto_generate_reading_code()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_prefix   TEXT;
  v_next_seq INT;
BEGIN
  -- Respect an explicitly supplied code.
  IF NEW.reading_code IS NOT NULL AND NEW.reading_code <> '' THEN
    RETURN NEW;
  END IF;

  v_prefix := 'CSS' || TO_CHAR(NEW.reading_date, 'YYMM');

  -- Serialize code generation for this prefix to avoid two concurrent
  -- inserts reading the same MAX (released automatically at txn end).
  PERFORM pg_advisory_xact_lock(hashtext(v_prefix));

  -- Global next sequence for this prefix (NOT scoped to user_id).
  SELECT COALESCE(MAX(CAST(substring(reading_code FROM length(v_prefix) + 1) AS INT)), 0) + 1
    INTO v_next_seq
    FROM meter_readings
   WHERE reading_code LIKE v_prefix || '%'
     AND substring(reading_code FROM length(v_prefix) + 1) ~ '^[0-9]+$';

  NEW.reading_code := v_prefix || LPAD(v_next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.auto_generate_reading_code() IS
  'BEFORE INSERT trigger: generate globally-unique reading_code CSS{YYMM}{seq}. Sequence is global per prefix (MAX+1) with a per-prefix advisory lock; idx_meter_readings_code is a global unique index so per-user numbering would collide across owners.';
