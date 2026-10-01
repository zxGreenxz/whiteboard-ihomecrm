-- Release step only: apply after final TEST integration proofs and compatible
-- application promotion. Do not use this global switch for synthetic fixtures.
-- Recovery is a NEW forward migration restoring SELECT false; preserve all
-- plans, claims, withholding events, receipts and posted money.
DO $$
BEGIN
 IF to_regclass('app_private.contract_rent_support_plans') IS NULL
 OR to_regclass('app_private.contract_rent_support_months') IS NULL
 OR to_regclass('app_private.rent_support_invoice_claims') IS NULL
 OR to_regclass('app_private.rent_support_source_aliases') IS NULL
 OR to_regclass('app_private.rent_support_payout_results') IS NULL
 OR to_regclass('app_private.rent_support_withholding_events') IS NULL
 OR to_regclass('app_private.rent_support_salary_parts') IS NULL
 OR to_regclass('app_private.rent_support_reconciliations') IS NULL THEN
  RAISE EXCEPTION 'Rent support schema dependencies are missing' USING ERRCODE='55000';
 END IF;
 IF to_regprocedure('app_private.rent_support_party_in_building_v1(uuid,uuid,uuid)') IS NULL
 OR to_regprocedure('app_private.invoice_rent_support_quote_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint)') IS NULL
 OR to_regprocedure('public.prepare_contract_payouts_with_support_v1(uuid,uuid,bigint,text,jsonb,uuid)') IS NULL
 OR to_regprocedure('public.execute_contract_payout_operation_v1(uuid,uuid)') IS NULL
 OR to_regprocedure('public.read_rent_support_deposit_candidate_v1(uuid,uuid)') IS NULL
 OR to_regprocedure('public.read_rent_support_salary_parts_v1(uuid[],date)') IS NULL
 OR to_regprocedure('public.apply_rent_support_reconciliation_v1(uuid,text,jsonb,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'Rent support canonical writer dependencies are missing' USING ERRCODE='55000';
 END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.income_expenses','rent_support_commission_insert_guard'),
   ('public.income_expenses','rent_support_salary_insert_guard'),
   ('public.salary_monthly','rent_support_salary_snapshot_guard'),
   ('public.income_expenses','rent_support_deposit_adoption_guard'),
   ('public.income_expenses','a00_rent_support_lifecycle'),
   ('public.income_expense_items','a00_rent_support_lifecycle'),
   ('public.income_expense_postings','a00_rent_support_lifecycle')
  ) required(relation_name,trigger_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid=to_regclass(required.relation_name) AND t.tgname=required.trigger_name
   AND NOT t.tgisinternal AND t.tgenabled IN ('O','A'))
 ) THEN
  RAISE EXCEPTION 'Rent support money guards are missing or disabled' USING ERRCODE='55000';
 END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('app_private.rent_support_lifecycle_requests','rent_support_lifecycle_actor_request_key'),
   ('app_private.rent_support_reconciliation_batches','rent_support_reconciliation_actor_request_key')
  ) required(relation_name,constraint_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid=to_regclass(required.relation_name) AND c.conname=required.constraint_name
   AND c.contype='u' AND pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (organization_id, actor_id, request_id)')
 ) THEN
  RAISE EXCEPTION 'Rent support actor request identity guards are missing' USING ERRCODE='55000';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT true $$;
ALTER FUNCTION app_private.rent_support_writers_enabled_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_writers_enabled_v1() FROM PUBLIC,anon,authenticated,service_role;
