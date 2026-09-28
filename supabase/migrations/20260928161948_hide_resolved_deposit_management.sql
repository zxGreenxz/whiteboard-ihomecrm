-- Display-only exclusion authorized by the user on 2026-09-28. Preserve the
-- original receipt, deposit classification, contract, postings and holding guards.
CREATE TABLE IF NOT EXISTS public.deposit_management_exclusions (
  voucher_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  hidden_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_management_exclusions_voucher_id_fkey
    FOREIGN KEY (voucher_id) REFERENCES public.income_expenses(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS deposit_management_exclusions_org_idx
  ON public.deposit_management_exclusions(organization_id);

ALTER TABLE public.deposit_management_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deposit_management_exclusions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.deposit_management_exclusions TO authenticated;

-- The invoker must be able to read the original voucher, including all existing
-- organization, building and restricted-item policies on income_expenses.
DROP POLICY IF EXISTS deposit_management_exclusions_select ON public.deposit_management_exclusions;
CREATE POLICY deposit_management_exclusions_select ON public.deposit_management_exclusions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = deposit_management_exclusions.voucher_id
      AND ie.organization_id = deposit_management_exclusions.organization_id
  ));
-- Boundary automation can install permissive policies. This second, restrictive
-- predicate prevents those policies from broadening the source voucher's scope.
DROP POLICY IF EXISTS deposit_management_exclusions_source_scope ON public.deposit_management_exclusions;
CREATE POLICY deposit_management_exclusions_source_scope ON public.deposit_management_exclusions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = deposit_management_exclusions.voucher_id
      AND ie.organization_id = deposit_management_exclusions.organization_id
  ));
DROP POLICY IF EXISTS deposit_management_exclusions_hide_sandbox_admin ON public.deposit_management_exclusions;
CREATE POLICY deposit_management_exclusions_hide_sandbox_admin ON public.deposit_management_exclusions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(public.is_super_admin() AND organization_id = ANY(public.sandbox_org_ids()), false));

COMMENT ON TABLE public.deposit_management_exclusions IS
  'Display-only exceptions for Deposit Management. Migration-owned metadata; no financial effect or public writer.';

DO $seed$
DECLARE
  source public.income_expenses;
  deposit_amount numeric;
  expected_reason constant text := 'Direct user authorization 2026-09-28: display-only exclusion of obsolete hold PT2605043 from Deposit Management; immutable source receipt and financial records preserved.';
BEGIN
  SELECT * INTO source FROM public.income_expenses
    WHERE id = '6196cec6-6c35-4ed5-87c7-e39c12f0f34f'::uuid;
  -- An unrelated/fresh database has no such receipt and gets no seeded exception.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(it.amount), 0) INTO deposit_amount
    FROM public.income_expense_items it
    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id = source.id AND t.is_deposit = true;
  IF ROW(source.organization_id, source.code, source.building_id, source.room_id,
         source.type::text, source.approval_status::text, source.posting_status::text, source.total_amount)
    IS DISTINCT FROM ROW(
      'aaaa0000-0000-4000-8000-000000000001'::uuid, 'PT2605043'::text,
      '59c6fc2c-2369-4ec8-b253-1ac64abb2f45'::uuid,
      '46a8f5e8-cc72-4c32-a288-0dafe93f343c'::uuid,
      'INCOME'::text, 'APPROVED'::text, 'POSTED'::text, 5000000::numeric)
    OR source.contract_id IS NOT NULL OR source.deleted_at IS NOT NULL
    OR deposit_amount IS DISTINCT FROM 5000000::numeric THEN
    RAISE EXCEPTION 'Deposit management exclusion source mismatch' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.deposit_management_exclusions(voucher_id, organization_id, reason)
    VALUES(source.id, source.organization_id, expected_reason)
    ON CONFLICT (voucher_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.deposit_management_exclusions ex
    WHERE ex.voucher_id = source.id AND ex.organization_id = source.organization_id
      AND ex.reason = expected_reason
  ) THEN
    RAISE EXCEPTION 'Deposit management exclusion metadata mismatch' USING ERRCODE = '55000';
  END IF;
END $seed$;

-- Patch the measured anchor in the deployed invoker, preserving its settlement
-- filter, complete definition, owner, ACL and settings. Fail closed on drift.
DO $summary$
DECLARE
  signature constant text := 'public.get_reservation_deposit_summary(uuid[])';
  anchor constant text := 'WHERE ie.contract_id IS NULL';
  exclusion constant text := 'AND NOT EXISTS (SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id = ie.id AND ex.organization_id = ie.organization_id)';
  definition text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = signature::regprocedure AND NOT prosecdef) THEN
    RAISE EXCEPTION 'Deposit management summary must remain SECURITY INVOKER' USING ERRCODE = '55000';
  END IF;
  definition := pg_get_functiondef(signature::regprocedure);
  IF strpos(definition, exclusion) > 0 THEN RETURN; END IF;
  IF strpos(definition, 'deposit_management_exclusions') > 0
    OR length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'Deposit management summary catalog drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, anchor || E'\n      ' || exclusion);
END $summary$;
