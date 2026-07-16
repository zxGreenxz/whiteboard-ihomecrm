-- HOTFIX — _autofill_org dùng min(organization_id) trên cột uuid → function min(uuid)
-- does not exist ⇒ trigger CRASH khi rơi vào nhánh membership (parent columns đều NULL
-- + user_id present). Bug do 20260716120300 gây ra. Chưa gây thiệt hại (0 insert kể từ
-- apply) nhưng phải sửa trước khi có insert nào rơi vào nhánh này (28 bảng có trigger).
-- Fix: thay min(uuid) bằng pattern uuid-safe (array_agg ... )[1], giữ nguyên logic
-- "chỉ dùng khi ĐÚNG 1 org". Vẫn additive/CREATE OR REPLACE, không đụng dữ liệu.
BEGIN;

CREATE OR REPLACE FUNCTION public._autofill_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
  n_orgs int;
  PROD constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
BEGIN
  IF NEW.organization_id IS NOT NULL THEN RETURN NEW; END IF;
  IF (j->>'building_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.buildings WHERE id=(j->>'building_id')::uuid; END IF;
  IF v IS NULL AND (j->>'room_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.rooms WHERE id=(j->>'room_id')::uuid; END IF;
  IF v IS NULL AND (j->>'contract_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.contracts WHERE id=(j->>'contract_id')::uuid; END IF;
  IF v IS NULL AND (j->>'invoice_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.invoices WHERE id=(j->>'invoice_id')::uuid; END IF;
  IF v IS NULL AND (j->>'income_expense_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.income_expenses WHERE id=(j->>'income_expense_id')::uuid; END IF;
  IF v IS NULL AND (j->>'account_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.accounts WHERE id=(j->>'account_id')::uuid; END IF;
  IF v IS NULL AND (j->>'customer_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.customers WHERE id=(j->>'customer_id')::uuid; END IF;
  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (uuid-safe, không dùng min()).
  IF v IS NULL AND (j->>'user_id') IS NOT NULL THEN
    SELECT (array_agg(DISTINCT organization_id))[1], count(DISTINCT organization_id)
      INTO v, n_orgs
      FROM public.organization_memberships
     WHERE user_id=(j->>'user_id')::uuid AND status='ACTIVE';
    IF n_orgs IS DISTINCT FROM 1 THEN v := NULL; END IF;
  END IF;

  IF v IS NULL THEN
    BEGIN
      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)
      VALUES (TG_TABLE_NAME, 'PROD_DEFAULT_FALLBACK at insert',
              jsonb_build_object('source', '_autofill_org', 'at', now(),
                                 'new_row_keys', (SELECT jsonb_object_agg(k, j->k)
                                                  FROM unnest(ARRAY['id','user_id','building_id','room_id','contract_id','invoice_id','account_id','customer_id']) AS k
                                                  WHERE j ? k)));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    v := PROD;
  END IF;

  NEW.organization_id := v;
  RETURN NEW;
END;
$function$;

COMMIT;
