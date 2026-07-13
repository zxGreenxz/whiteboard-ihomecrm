-- =============================================================================
-- Sprint 3b — Auto-fill organization_id trên INSERT + RESTRICTIVE org-boundary
-- policy cho các bảng tenant cốt lõi (financial/entity/PII).
-- (AUTHORIZATION-PLAN.md §11.1, §16.3, §17 Sprint 3)
--
-- AN TOÀN: restrictive = AND với policy hiện có ⇒ CHỈ siết, không nới. Cho phép
-- organization_id IS NULL (không vỡ INSERT cũ chưa set) và giữ super_admin bypass.
-- Auto-fill trigger set org từ parent/owner cho row MỚI (org column giữ ý nghĩa).
-- Đã verify 0 cross-org mismatch ở 3a ⇒ không chặn nhầm row hợp lệ.
-- Rollback = DROP policy/trigger. Idempotent.
-- =============================================================================

BEGIN;

-- Helper: các org mà caller là ACTIVE member (SECURITY DEFINER bypass RLS membership).
CREATE OR REPLACE FUNCTION public.my_org_ids()
 RETURNS uuid[]
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT COALESCE(array_agg(organization_id), '{}'::uuid[])
  FROM public.organization_memberships
  WHERE user_id = auth.uid() AND status = 'ACTIVE';
$fn$;
REVOKE ALL ON FUNCTION public.my_org_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_org_ids() TO authenticated;

-- Generic auto-fill: derive org từ parent columns (qua to_jsonb) hoặc user_id.
CREATE OR REPLACE FUNCTION public._autofill_org()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
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
  IF v IS NULL AND (j->>'user_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.organization_memberships WHERE user_id=(j->>'user_id')::uuid AND status='ACTIVE' LIMIT 1; END IF;
  NEW.organization_id := COALESCE(v, PROD);
  RETURN NEW;
END;
$fn$;

-- Attach auto-fill + restrictive boundary trên core tenant tables.
DO $do$
DECLARE
  t text;
  core text[] := ARRAY[
    'income_expenses','income_expense_items','income_expense_batches','income_expense_batch_items',
    'invoices','invoice_items','payments','excess_amounts','deposits',
    'contracts','contract_customers','contract_tenants','contract_services',
    'contract_extensions','contract_terminations','contract_transfers',
    'customers','tenants','rooms','floors','meters','meter_readings','services',
    'building_services','vehicles','leads','assets','jobs'
  ];
BEGIN
  FOREACH t IN ARRAY core LOOP
    -- auto-fill BEFORE INSERT
    EXECUTE format('DROP TRIGGER IF EXISTS trg_autofill_org ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public._autofill_org()', t);
    -- RESTRICTIVE org boundary (NULL-tolerant, super_admin bypass)
    EXECUTE format('DROP POLICY IF EXISTS %I_org_boundary ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_org_boundary ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
      WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))$p$, t, t);
  END LOOP;
END $do$;

COMMIT;

-- =============================================================================
-- ROLLBACK: for each core table DROP POLICY <t>_org_boundary; DROP TRIGGER
-- trg_autofill_org ON <t>; then DROP FUNCTION _autofill_org(), my_org_ids().
-- =============================================================================
