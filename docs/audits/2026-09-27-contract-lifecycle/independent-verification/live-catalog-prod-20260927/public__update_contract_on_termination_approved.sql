-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.update_contract_on_termination_approved() md5(prosrc)=11a78d11938a9dee1f7ac7d6d2c002fd
CREATE OR REPLACE FUNCTION public.update_contract_on_termination_approved()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- When termination is approved, update the contract
  IF TG_OP = 'UPDATE' AND OLD.status != 'APPROVED' AND NEW.status = 'APPROVED' THEN
    UPDATE contracts
    SET
      status = 'TERMINATED',
      actual_end_date = NEW.actual_move_out_date,
      updated_at = NOW()
    WHERE id = NEW.contract_id;

    -- Record approval timestamp
    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$

