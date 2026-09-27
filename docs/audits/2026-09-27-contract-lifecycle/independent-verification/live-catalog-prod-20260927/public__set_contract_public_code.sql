-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.set_contract_public_code() md5(prosrc)=6d5464387a957e5497bd1b0e4c3d819b
CREATE OR REPLACE FUNCTION public.set_contract_public_code()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  candidate text;
  tries int := 0;
BEGIN
  IF NEW.public_code IS NOT NULL AND NEW.public_code <> '' THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := public.gen_contract_public_code(6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE public_code = candidate);
    tries := tries + 1;
    IF tries >= 10 THEN
      candidate := public.gen_contract_public_code(8);
      EXIT;
    END IF;
  END LOOP;
  NEW.public_code := candidate;
  RETURN NEW;
END;
$function$

