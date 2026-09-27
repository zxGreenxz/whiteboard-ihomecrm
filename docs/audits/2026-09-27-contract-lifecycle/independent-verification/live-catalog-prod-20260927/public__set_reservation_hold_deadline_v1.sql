-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.set_reservation_hold_deadline_v1(p_income_expense_id uuid, p_hold_until date) md5(prosrc)=c7043a1c61bfd26ad0e37fb4cb2c8ab1
CREATE OR REPLACE FUNCTION public.set_reservation_hold_deadline_v1(p_income_expense_id uuid, p_hold_until date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_topup  date;
  v_target numeric;
BEGIN
  SELECT topup_due_date, deposit_target INTO v_topup, v_target
    FROM public.reservation_hold_deadlines
   WHERE income_expense_id = p_income_expense_id;

  RETURN public.set_reservation_hold_terms_v1(
    p_income_expense_id, p_hold_until, v_topup, v_target);
END;
$function$

