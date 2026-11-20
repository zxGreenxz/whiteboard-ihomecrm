-- Determine the maker on the server for new advances. Retain the existing cashbook,
-- membership, payee eligibility, locking and idempotency checks in R4 and W1.
-- OWNER uses the same approval and posting commands as a shareholder settlement.
BEGIN;

CREATE OR REPLACE FUNCTION app_private.profit_advance_maker_kind_v1(p_org uuid, p_self boolean)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN app_private.ie_actor_is_company_owner_v1(p_org, auth.uid()) OR public.is_super_admin() THEN 'OWNER'
    WHEN p_self THEN 'CUSTODIAN_ADVANCE'
    ELSE 'CUSTODIAN_FOR_PAYEE'
  END
$$;
REVOKE ALL ON FUNCTION app_private.profit_advance_maker_kind_v1(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Keep the legacy JSON maker_kind accepted by already-open clients. The server stores
-- the effective maker on the new payout. Updated clients use the additional flag.
DO $migration$
DECLARE
  change record;
  def text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)'::regprocedure,
      $old$'payee_is_maker', v_self,$old$,
      $new$'owner_workflow', app_private.profit_advance_maker_kind_v1(v_sh.organization_id, v_self) = 'OWNER',
    'payee_is_maker', v_self,$new$),
    ('public.shareholder_profit_advance_v1(uuid,numeric,uuid,date,text,text)'::regprocedure,
      $old$v_maker_kind := CASE WHEN v_self THEN 'CUSTODIAN_ADVANCE' ELSE 'CUSTODIAN_FOR_PAYEE' END;$old$,
      $new$v_maker_kind := app_private.profit_advance_maker_kind_v1(v_org, v_self);$new$),
    ('public.shareholder_profit_advance_v1(uuid,numeric,uuid,date,text,text)'::regprocedure,
      $old$'maker_kind', v_maker_kind,$old$,
      $new$'owner_workflow', v_maker_kind = 'OWNER',
    'maker_kind', CASE WHEN v_self THEN 'CUSTODIAN_ADVANCE' ELSE 'CUSTODIAN_FOR_PAYEE' END,$new$)
  ) AS replacements(signature, original, replacement)
  LOOP
    def := pg_get_functiondef(change.signature);
    IF strpos(def, change.replacement) > 0 THEN CONTINUE; END IF;
    IF array_length(string_to_array(def, change.original), 1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected advance definition for %', change.signature;
    END IF;
    EXECUTE replace(def, change.original, change.replacement);
  END LOOP;
END
$migration$;
COMMIT;
