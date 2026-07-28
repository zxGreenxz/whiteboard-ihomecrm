-- Canonical invoice components, prospective component allocations, cohort and
-- cash-in RPCs, plus category breakdown for Business Performance.

BEGIN;

CREATE TABLE public.finance_invoice_component_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  component_status text NOT NULL,
  invoice_total numeric(15,2) NOT NULL,
  component_total numeric(15,2) NOT NULL,
  component_version integer NOT NULL DEFAULT 1,
  anomaly_code text,
  source_updated_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  CONSTRAINT finance_invoice_component_manifests_invoice_uq UNIQUE (invoice_id),
  CONSTRAINT finance_invoice_component_manifests_invoice_org_fkey
    FOREIGN KEY (invoice_id, organization_id)
    REFERENCES public.invoices(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_component_manifests_status_check
    CHECK (component_status IN ('COMPLETE', 'ANOMALY')),
  CONSTRAINT finance_invoice_component_manifests_amount_check CHECK (
    invoice_total <> 'NaN'::numeric
    AND component_total <> 'NaN'::numeric
  )
);

CREATE TABLE public.finance_invoice_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL
    REFERENCES public.finance_invoice_component_manifests(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  component_kind text NOT NULL,
  amount numeric(15,2) NOT NULL,
  component_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_invoice_components_manifest_kind_uq
    UNIQUE (manifest_id, component_kind),
  CONSTRAINT finance_invoice_components_kind_check CHECK (
    component_kind IN (
      'CURRENT_CHARGE',
      'CARRIED_INVOICE_DEBT',
      'CARRIED_DEPOSIT_DEBT',
      'CURRENT_DEPOSIT',
      'INTERNAL',
      'SETTLEMENT',
      'UNCLASSIFIED'
    )
  ),
  CONSTRAINT finance_invoice_components_amount_check
    CHECK (amount <> 'NaN'::numeric AND amount >= 0),
  CONSTRAINT finance_invoice_components_order_check
    CHECK (component_order BETWEEN 1 AND 99)
);

CREATE UNIQUE INDEX finance_invoice_components_id_org_uq
  ON public.finance_invoice_components(id, organization_id);
CREATE INDEX finance_invoice_components_invoice_idx
  ON public.finance_invoice_components(organization_id, invoice_id, component_order);

CREATE TABLE public.finance_invoice_component_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  collection_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  component_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL,
  allocation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_invoice_component_allocations_collection_component_uq
    UNIQUE (collection_id, component_id),
  CONSTRAINT finance_invoice_component_allocations_collection_org_fkey
    FOREIGN KEY (collection_id, organization_id)
    REFERENCES public.invoice_payment_collections(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_component_allocations_invoice_org_fkey
    FOREIGN KEY (invoice_id, organization_id)
    REFERENCES public.invoices(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_component_allocations_component_org_fkey
    FOREIGN KEY (component_id, organization_id)
    REFERENCES public.finance_invoice_components(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_component_allocations_amount_check
    CHECK (amount <> 'NaN'::numeric AND amount > 0)
);

CREATE INDEX finance_invoice_component_allocations_component_idx
  ON public.finance_invoice_component_allocations(component_id, collection_id);
CREATE INDEX finance_invoice_component_allocations_invoice_idx
  ON public.finance_invoice_component_allocations(organization_id, invoice_id, created_at);

ALTER TABLE public.finance_invoice_component_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_invoice_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_invoice_component_allocations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.finance_invoice_component_manifests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_invoice_components FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_invoice_component_allocations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.sync_finance_invoice_components_v1(
  p_invoice_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $sync_finance_invoice_components$
DECLARE
  v_invoice record;
  v_manifest_id uuid;
  v_manifest_finalized_at timestamptz;
  v_previous_invoice numeric := 0;
  v_previous_deposit numeric := 0;
  v_previous_source_total numeric := 0;
  v_invalid_source_count integer := 0;
  v_current_deposit numeric := 0;
  v_internal numeric := 0;
  v_current_charge numeric := 0;
  v_settlement numeric := 0;
  v_unclassified numeric := 0;
  v_component_total numeric := 0;
  v_status text := 'COMPLETE';
  v_anomaly text;
  v_should_finalize boolean;
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    invoice_row.id,
    invoice_row.organization_id,
    invoice_row.kind,
    invoice_row.status::text AS status,
    COALESCE(invoice_row.total_amount, 0)::numeric AS total_amount,
    COALESCE(invoice_row.previous_debt, 0)::numeric AS previous_debt,
    COALESCE(invoice_row.previous_debt_sources, '[]'::jsonb) AS previous_debt_sources,
    invoice_row.updated_at
    INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invoice-components:' || p_invoice_id::text, 0));

  SELECT manifest.id, manifest.finalized_at
    INTO v_manifest_id, v_manifest_finalized_at
  FROM public.finance_invoice_component_manifests manifest
  WHERE manifest.invoice_id = p_invoice_id
  FOR UPDATE;

  IF v_manifest_finalized_at IS NOT NULL THEN
    RETURN v_manifest_id;
  END IF;

  IF jsonb_typeof(v_invoice.previous_debt_sources) <> 'array' THEN
    v_invalid_source_count := 1;
  ELSE
    SELECT
      COALESCE(sum(
        CASE WHEN source.value->>'type' = 'invoice'
          AND COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
          THEN (source.value->>'amount')::numeric ELSE 0 END
      ), 0),
      COALESCE(sum(
        CASE WHEN source.value->>'type' = 'deposit'
          AND COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
          THEN (source.value->>'amount')::numeric ELSE 0 END
      ), 0),
      count(*) FILTER (
        WHERE source.value->>'type' NOT IN ('invoice', 'deposit')
          OR COALESCE(source.value->>'amount', '') !~ '^[-+]?[0-9]+([.][0-9]+)?$'
          OR CASE
            WHEN COALESCE(source.value->>'amount', '') ~ '^[-+]?[0-9]+([.][0-9]+)?$'
              THEN (source.value->>'amount')::numeric < 0
            ELSE false
          END
      )::integer
      INTO v_previous_invoice, v_previous_deposit, v_invalid_source_count
    FROM jsonb_array_elements(v_invoice.previous_debt_sources) source(value);
  END IF;

  v_previous_invoice := GREATEST(COALESCE(v_previous_invoice, 0), 0);
  v_previous_deposit := GREATEST(COALESCE(v_previous_deposit, 0), 0);
  v_previous_source_total := v_previous_invoice + v_previous_deposit;

  SELECT
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'NON_PNL'), 0)
    INTO v_current_deposit, v_internal
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id;

  v_current_deposit := GREATEST(COALESCE(v_current_deposit, 0), 0);
  v_internal := GREATEST(COALESCE(v_internal, 0), 0);

  IF v_invoice.kind = 'SETTLEMENT' THEN
    v_settlement := GREATEST(v_invoice.total_amount, 0);
    v_previous_invoice := 0;
    v_previous_deposit := 0;
    v_current_deposit := 0;
    v_internal := 0;
  ELSE
    IF v_invalid_source_count > 0
       OR abs(v_previous_source_total - v_invoice.previous_debt) >= 0.01 THEN
      v_unclassified := GREATEST(v_invoice.previous_debt, 0);
      v_previous_invoice := 0;
      v_previous_deposit := 0;
      v_status := 'ANOMALY';
      v_anomaly := 'PREVIOUS_DEBT_SOURCES_DO_NOT_RECONCILE';
    END IF;

    v_current_charge := v_invoice.total_amount
      - v_invoice.previous_debt
      - v_current_deposit
      - v_internal;
    IF v_current_charge < -0.01 THEN
      v_status := 'ANOMALY';
      v_anomaly := COALESCE(v_anomaly, 'CURRENT_COMPONENTS_EXCEED_INVOICE_TOTAL');
      v_unclassified := GREATEST(v_invoice.total_amount, 0);
      v_current_charge := 0;
      v_previous_invoice := 0;
      v_previous_deposit := 0;
      v_current_deposit := 0;
      v_internal := 0;
    ELSE
      v_current_charge := GREATEST(v_current_charge, 0);
    END IF;
  END IF;

  v_component_total := v_current_charge
    + v_previous_invoice
    + v_previous_deposit
    + v_current_deposit
    + v_internal
    + v_settlement
    + v_unclassified;
  IF abs(v_component_total - v_invoice.total_amount) >= 0.01 THEN
    v_status := 'ANOMALY';
    v_anomaly := COALESCE(v_anomaly, 'COMPONENT_TOTAL_DOES_NOT_RECONCILE');
  END IF;

  v_should_finalize := v_invoice.status IN (
    'APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE', 'CANCELLED'
  );

  IF v_manifest_id IS NULL THEN
    INSERT INTO public.finance_invoice_component_manifests (
      organization_id,
      invoice_id,
      component_status,
      invoice_total,
      component_total,
      component_version,
      anomaly_code,
      source_updated_at,
      captured_at,
      finalized_at
    ) VALUES (
      v_invoice.organization_id,
      p_invoice_id,
      v_status,
      v_invoice.total_amount,
      v_component_total,
      1,
      v_anomaly,
      v_invoice.updated_at,
      clock_timestamp(),
      CASE WHEN v_should_finalize THEN clock_timestamp() ELSE NULL END
    ) RETURNING id INTO v_manifest_id;
  ELSE
    DELETE FROM public.finance_invoice_components component
    WHERE component.manifest_id = v_manifest_id;
    UPDATE public.finance_invoice_component_manifests manifest
    SET
      component_status = v_status,
      invoice_total = v_invoice.total_amount,
      component_total = v_component_total,
      component_version = manifest.component_version + 1,
      anomaly_code = v_anomaly,
      source_updated_at = v_invoice.updated_at,
      captured_at = clock_timestamp(),
      finalized_at = CASE WHEN v_should_finalize THEN clock_timestamp() ELSE NULL END
    WHERE manifest.id = v_manifest_id;
  END IF;

  INSERT INTO public.finance_invoice_components (
    manifest_id, organization_id, invoice_id, component_kind, amount, component_order
  )
  SELECT v_manifest_id, v_invoice.organization_id, p_invoice_id, component.kind, component.amount, component.sort_order
  FROM (
    VALUES
      ('CARRIED_INVOICE_DEBT'::text, v_previous_invoice, 10),
      ('CURRENT_CHARGE'::text, v_current_charge, 20),
      ('CARRIED_DEPOSIT_DEBT'::text, v_previous_deposit, 30),
      ('CURRENT_DEPOSIT'::text, v_current_deposit, 40),
      ('INTERNAL'::text, v_internal, 50),
      ('SETTLEMENT'::text, v_settlement, 60),
      ('UNCLASSIFIED'::text, v_unclassified, 90)
  ) component(kind, amount, sort_order)
  WHERE component.amount > 0;

  RETURN v_manifest_id;
END;
$sync_finance_invoice_components$;

REVOKE ALL ON FUNCTION app_private.sync_finance_invoice_components_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Backfill only canonical component identity. Payment allocation is not
-- guessed for historical multi-component invoices: it remains allocation_unknown.
DO $backfill_finance_invoice_components$
DECLARE
  v_invoice record;
BEGIN
  FOR v_invoice IN
    SELECT invoice_row.id
    FROM public.invoices invoice_row
    WHERE invoice_row.deleted_at IS NULL
      AND invoice_row.status::text IN (
        'APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE', 'CANCELLED'
      )
    ORDER BY invoice_row.id
  LOOP
    PERFORM app_private.sync_finance_invoice_components_v1(v_invoice.id);
  END LOOP;
END;
$backfill_finance_invoice_components$;

CREATE OR REPLACE FUNCTION app_private.allocate_finance_collection_components_v1(
  p_collection_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $allocate_finance_collection_components$
DECLARE
  v_collection record;
  v_manifest record;
  v_prior_applied numeric := 0;
  v_prior_allocated numeric := 0;
  v_positive_component_count integer := 0;
  v_remaining_capacity numeric := 0;
  v_left numeric := 0;
  v_component record;
  v_already_allocated numeric;
  v_amount numeric;
BEGIN
  IF p_collection_id IS NULL THEN
    RETURN;
  END IF;

  SELECT collection_row.id,
         collection_row.organization_id,
         collection_row.invoice_id,
         collection_row.applied_amount,
         collection_row.status,
         collection_row.created_at
    INTO v_collection
  FROM public.invoice_payment_collections collection_row
  WHERE collection_row.id = p_collection_id
  FOR SHARE;
  IF NOT FOUND OR v_collection.status <> 'ACTIVE' THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('invoice-component-allocation:' || v_collection.invoice_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.finance_invoice_component_allocations allocation
    WHERE allocation.collection_id = p_collection_id
  ) THEN
    RETURN;
  END IF;

  SELECT manifest.id,
         manifest.component_status,
         manifest.finalized_at
    INTO v_manifest
  FROM public.finance_invoice_component_manifests manifest
  WHERE manifest.invoice_id = v_collection.invoice_id
  FOR SHARE;
  IF NOT FOUND
     OR v_manifest.component_status <> 'COMPLETE'
     OR v_manifest.finalized_at IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_positive_component_count
  FROM public.finance_invoice_components component
  WHERE component.manifest_id = v_manifest.id
    AND component.amount > 0;

  SELECT COALESCE(sum(prior.applied_amount), 0)
    INTO v_prior_applied
  FROM public.invoice_payment_collections prior
  WHERE prior.invoice_id = v_collection.invoice_id
    AND prior.status = 'ACTIVE'
    AND (prior.created_at, prior.id) < (v_collection.created_at, v_collection.id);

  SELECT COALESCE(sum(allocation.amount), 0)
    INTO v_prior_allocated
  FROM public.finance_invoice_component_allocations allocation
  JOIN public.invoice_payment_collections prior
    ON prior.id = allocation.collection_id
   AND prior.status = 'ACTIVE'
  WHERE allocation.invoice_id = v_collection.invoice_id;

  -- Oldest carried invoice debt -> current charges -> deposit debt -> internal.
  -- If a historical multi-component payment has no ledger allocation, preserve
  -- allocation_unknown instead of guessing how the old money was distributed.
  IF v_positive_component_count > 1
     AND abs(v_prior_applied - v_prior_allocated) >= 0.01 THEN
    RETURN;
  END IF;

  SELECT COALESCE(sum(GREATEST(component.amount - COALESCE(active_allocated.amount, 0), 0)), 0)
    INTO v_remaining_capacity
  FROM public.finance_invoice_components component
  LEFT JOIN LATERAL (
    SELECT sum(allocation.amount) AS amount
    FROM public.finance_invoice_component_allocations allocation
    JOIN public.invoice_payment_collections active_collection
      ON active_collection.id = allocation.collection_id
     AND active_collection.status = 'ACTIVE'
    WHERE allocation.component_id = component.id
  ) active_allocated ON true
  WHERE component.manifest_id = v_manifest.id;

  IF v_collection.applied_amount <= 0
     OR v_remaining_capacity + 0.01 < v_collection.applied_amount THEN
    RETURN;
  END IF;

  v_left := v_collection.applied_amount;
  FOR v_component IN
    SELECT component.id, component.amount, component.component_order
    FROM public.finance_invoice_components component
    WHERE component.manifest_id = v_manifest.id
    ORDER BY component.component_order, component.id
  LOOP
    SELECT COALESCE(sum(allocation.amount), 0)
      INTO v_already_allocated
    FROM public.finance_invoice_component_allocations allocation
    JOIN public.invoice_payment_collections active_collection
      ON active_collection.id = allocation.collection_id
     AND active_collection.status = 'ACTIVE'
    WHERE allocation.component_id = v_component.id;

    v_amount := LEAST(v_left, GREATEST(v_component.amount - v_already_allocated, 0));
    IF v_amount > 0 THEN
      INSERT INTO public.finance_invoice_component_allocations (
        organization_id,
        collection_id,
        invoice_id,
        component_id,
        amount,
        allocation_version
      ) VALUES (
        v_collection.organization_id,
        v_collection.id,
        v_collection.invoice_id,
        v_component.id,
        v_amount,
        1
      );
      v_left := v_left - v_amount;
    END IF;
    EXIT WHEN v_left < 0.01;
  END LOOP;
END;
$allocate_finance_collection_components$;

REVOKE ALL ON FUNCTION app_private.allocate_finance_collection_components_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.queue_finance_invoice_component_sync_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $queue_finance_invoice_component_sync$
DECLARE
  v_invoice_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    v_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  END IF;
  PERFORM app_private.sync_finance_invoice_components_v1(v_invoice_id);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$queue_finance_invoice_component_sync$;

REVOKE ALL ON FUNCTION app_private.queue_finance_invoice_component_sync_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.queue_finance_component_allocation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $queue_finance_component_allocation$
BEGIN
  PERFORM app_private.allocate_finance_collection_components_v1(NEW.collection_id);
  RETURN NEW;
END;
$queue_finance_component_allocation$;

REVOKE ALL ON FUNCTION app_private.queue_finance_component_allocation_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER finance_invoice_component_sync_from_invoice
AFTER INSERT OR UPDATE OF total_amount, previous_debt, previous_debt_sources, kind, status, updated_at
ON public.invoices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.queue_finance_invoice_component_sync_v1();

CREATE CONSTRAINT TRIGGER finance_invoice_component_sync_from_items
AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.queue_finance_invoice_component_sync_v1();

CREATE CONSTRAINT TRIGGER finance_invoice_component_allocate_from_accounting
AFTER INSERT ON public.invoice_payment_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.queue_finance_component_allocation_v1();

CREATE OR REPLACE FUNCTION app_private.guard_finance_invoice_component_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $guard_finance_invoice_component_immutability$
DECLARE
  v_finalized_at timestamptz;
  v_manifest_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'finance_invoice_component_allocations' THEN
    RAISE EXCEPTION 'Finance invoice component allocations are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'finance_invoice_component_manifests' THEN
    IF OLD.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Finalized finance invoice component manifest is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_manifest_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.manifest_id ELSE NEW.manifest_id END;
  SELECT manifest.finalized_at
    INTO v_finalized_at
  FROM public.finance_invoice_component_manifests manifest
  WHERE manifest.id = v_manifest_id;
  IF v_finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finalized finance invoice components are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$guard_finance_invoice_component_immutability$;

REVOKE ALL ON FUNCTION app_private.guard_finance_invoice_component_immutability_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER finance_invoice_component_manifests_immutable_guard
BEFORE UPDATE OR DELETE ON public.finance_invoice_component_manifests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_invoice_component_immutability_v1();

CREATE TRIGGER finance_invoice_components_immutable_guard
BEFORE UPDATE OR DELETE ON public.finance_invoice_components
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_invoice_component_immutability_v1();

CREATE TRIGGER finance_invoice_component_allocations_immutable_guard
BEFORE UPDATE OR DELETE ON public.finance_invoice_component_allocations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_invoice_component_immutability_v1();

CREATE OR REPLACE FUNCTION public.business_performance_invoice_cohort_v1(
  p_organization_id uuid,
  p_cohort_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  building_id uuid,
  building_name text,
  cohort_month date,
  cohort_available boolean,
  billed_current_charge numeric,
  collected_current_charge numeric,
  remaining_current_charge numeric,
  collection_rate_pct numeric,
  invoice_count integer,
  allocation_unknown_count integer,
  allocation_unknown_amount numeric,
  component_anomaly_count integer,
  carried_invoice_debt numeric,
  carried_deposit_debt numeric,
  current_deposit numeric,
  draft_pending_count integer,
  draft_pending_amount numeric,
  settlement_count integer,
  settlement_amount numeric,
  generated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_invoice_cohort$
DECLARE
  v_building_ids uuid[];
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_cohort_month IS NULL
     OR p_cohort_month <> date_trunc('month', p_cohort_month)::date THEN
    RAISE EXCEPTION 'Invoice cohort month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH requested_buildings AS MATERIALIZED (
    SELECT building_row.id,
           COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building') AS name
    FROM public.buildings building_row
    WHERE building_row.organization_id = p_organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual = false
      AND building_row.id = ANY(v_building_ids)
  ),
  issued AS MATERIALIZED (
    SELECT invoice_row.*
    FROM public.invoices invoice_row
    WHERE invoice_row.organization_id = p_organization_id
      AND invoice_row.building_id = ANY(v_building_ids)
      AND invoice_row.deleted_at IS NULL
      AND invoice_row.kind = 'MONTHLY'
      AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
      AND invoice_row.status::text IN ('APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE')
  ),
  component_pivot AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      manifest.component_status,
      manifest.finalized_at,
      count(component.id) FILTER (WHERE component.amount > 0)::integer AS positive_component_count,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CURRENT_CHARGE'), 0)::numeric AS current_charge,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CARRIED_INVOICE_DEBT'), 0)::numeric AS carried_invoice_debt,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CARRIED_DEPOSIT_DEBT'), 0)::numeric AS carried_deposit_debt,
      COALESCE(sum(component.amount) FILTER (WHERE component.component_kind = 'CURRENT_DEPOSIT'), 0)::numeric AS current_deposit
    FROM issued invoice_row
    LEFT JOIN public.finance_invoice_component_manifests manifest
      ON manifest.invoice_id = invoice_row.id
    LEFT JOIN public.finance_invoice_components component
      ON component.manifest_id = manifest.id
    GROUP BY invoice_row.id, manifest.component_status, manifest.finalized_at
  ),
  payment_events AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(sum(payment_row.amount) FILTER (
        WHERE payment_row.reversed_at IS NULL
          AND (payment_row.collection_id IS NULL OR collection_row.status = 'ACTIVE')
      ), 0)::numeric AS paid_event_amount
    FROM issued invoice_row
    LEFT JOIN public.payments payment_row
      ON payment_row.invoice_id = invoice_row.id
    LEFT JOIN public.invoice_payment_collections collection_row
      ON collection_row.id = payment_row.collection_id
    GROUP BY invoice_row.id
  ),
  allocation_facts AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(sum(allocation.amount) FILTER (
        WHERE allocation_collection.status = 'ACTIVE'
      ), 0)::numeric AS allocated_amount,
      COALESCE(sum(allocation.amount) FILTER (
        WHERE allocation_collection.status = 'ACTIVE'
          AND component.component_kind = 'CURRENT_CHARGE'
      ), 0)::numeric AS allocated_current_charge
    FROM issued invoice_row
    LEFT JOIN public.finance_invoice_component_allocations allocation
      ON allocation.invoice_id = invoice_row.id
    LEFT JOIN public.invoice_payment_collections allocation_collection
      ON allocation_collection.id = allocation.collection_id
    LEFT JOIN public.finance_invoice_components component
      ON component.id = allocation.component_id
    GROUP BY invoice_row.id
  ),
  payment_facts AS MATERIALIZED (
    SELECT
      invoice_row.id AS invoice_id,
      COALESCE(payment_row.paid_event_amount, 0)::numeric AS paid_event_amount,
      COALESCE(allocation_row.allocated_amount, 0)::numeric AS allocated_amount,
      COALESCE(allocation_row.allocated_current_charge, 0)::numeric AS allocated_current_charge
    FROM issued invoice_row
    LEFT JOIN payment_events payment_row ON payment_row.invoice_id = invoice_row.id
    LEFT JOIN allocation_facts allocation_row ON allocation_row.invoice_id = invoice_row.id
  ),
  per_invoice AS MATERIALIZED (
    SELECT
      invoice_row.id,
      invoice_row.building_id,
      invoice_row.total_amount,
      invoice_row.paid_amount,
      component_row.component_status,
      component_row.current_charge,
      component_row.carried_invoice_debt,
      component_row.carried_deposit_debt,
      component_row.current_deposit,
      payment_row.paid_event_amount,
      payment_row.allocated_amount,
      CASE
        WHEN component_row.component_status = 'COMPLETE'
         AND component_row.finalized_at IS NOT NULL
         AND abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
         AND component_row.positive_component_count = 1
         AND component_row.current_charge > 0
          THEN LEAST(payment_row.paid_event_amount, component_row.current_charge)
        WHEN component_row.component_status = 'COMPLETE'
         AND component_row.finalized_at IS NOT NULL
         AND abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
         AND abs(payment_row.allocated_amount - payment_row.paid_event_amount) < 0.01
          THEN LEAST(payment_row.allocated_current_charge, component_row.current_charge)
        ELSE NULL
      END::numeric AS collected_current_charge,
      component_row.component_status = 'COMPLETE'
        AND component_row.finalized_at IS NOT NULL AS component_complete,
      CASE
        WHEN payment_row.paid_event_amount = 0
          THEN component_row.component_status = 'COMPLETE'
            AND component_row.finalized_at IS NOT NULL
        WHEN component_row.positive_component_count = 1
         AND component_row.current_charge > 0
          THEN abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
        ELSE abs(payment_row.allocated_amount - payment_row.paid_event_amount) < 0.01
          AND abs(payment_row.paid_event_amount - invoice_row.paid_amount) < 0.01
      END AS allocation_complete
    FROM issued invoice_row
    LEFT JOIN component_pivot component_row ON component_row.invoice_id = invoice_row.id
    LEFT JOIN payment_facts payment_row ON payment_row.invoice_id = invoice_row.id
  ),
  issued_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS invoice_count,
      count(invoice_row.id) FILTER (
        WHERE NOT COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false)
      )::integer AS allocation_unknown_count,
      COALESCE(sum(COALESCE(invoice_row.current_charge, invoice_row.total_amount)) FILTER (
        WHERE NOT COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false)
      ), 0)::numeric AS allocation_unknown_amount,
      count(invoice_row.id) FILTER (
        WHERE invoice_row.component_status IS DISTINCT FROM 'COMPLETE'
      )::integer AS component_anomaly_count,
      bool_and(COALESCE(invoice_row.component_complete AND invoice_row.allocation_complete, false))
        FILTER (WHERE invoice_row.id IS NOT NULL) AS cohort_available,
      sum(invoice_row.current_charge)::numeric AS billed_current_charge,
      sum(invoice_row.collected_current_charge)::numeric AS collected_current_charge,
      sum(invoice_row.carried_invoice_debt)::numeric AS carried_invoice_debt,
      sum(invoice_row.carried_deposit_debt)::numeric AS carried_deposit_debt,
      sum(invoice_row.current_deposit)::numeric AS current_deposit
    FROM requested_buildings building_row
    LEFT JOIN per_invoice invoice_row ON invoice_row.building_id = building_row.id
    GROUP BY building_row.id
  ),
  pending_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS pending_count,
      COALESCE(sum(invoice_row.total_amount), 0)::numeric AS pending_amount
    FROM requested_buildings building_row
    LEFT JOIN public.invoices invoice_row
      ON invoice_row.building_id = building_row.id
     AND invoice_row.organization_id = p_organization_id
     AND invoice_row.deleted_at IS NULL
     AND invoice_row.kind = 'MONTHLY'
     AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
     AND invoice_row.status::text IN ('DRAFT', 'PENDING_APPROVAL')
    GROUP BY building_row.id
  ),
  settlement_aggregate AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      count(invoice_row.id)::integer AS settlement_count,
      COALESCE(sum(invoice_row.total_amount), 0)::numeric AS settlement_amount
    FROM requested_buildings building_row
    LEFT JOIN public.invoices invoice_row
      ON invoice_row.building_id = building_row.id
     AND invoice_row.organization_id = p_organization_id
     AND invoice_row.deleted_at IS NULL
     AND invoice_row.kind = 'SETTLEMENT'
     AND invoice_row.billing_month = to_char(p_cohort_month, 'YYYY-MM')
    GROUP BY building_row.id
  )
  SELECT
    building_row.id,
    building_row.name,
    p_cohort_month,
    COALESCE(issued_row.cohort_available, true),
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.billed_current_charge, 0) ELSE NULL END,
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.collected_current_charge, 0) ELSE NULL END,
    CASE WHEN COALESCE(issued_row.cohort_available, true)
      THEN COALESCE(issued_row.billed_current_charge, 0)
        - COALESCE(issued_row.collected_current_charge, 0)
      ELSE NULL END,
    CASE
      WHEN NOT COALESCE(issued_row.cohort_available, true) THEN NULL
      WHEN COALESCE(issued_row.billed_current_charge, 0) = 0 THEN NULL
      ELSE round(
        COALESCE(issued_row.collected_current_charge, 0) * 100.0
          / issued_row.billed_current_charge,
        2
      )
    END,
    issued_row.invoice_count,
    issued_row.allocation_unknown_count,
    issued_row.allocation_unknown_amount,
    issued_row.component_anomaly_count,
    COALESCE(issued_row.carried_invoice_debt, 0),
    COALESCE(issued_row.carried_deposit_debt, 0),
    COALESCE(issued_row.current_deposit, 0),
    pending_row.pending_count,
    pending_row.pending_amount,
    settlement_row.settlement_count,
    settlement_row.settlement_amount,
    clock_timestamp()
  FROM requested_buildings building_row
  JOIN issued_aggregate issued_row ON issued_row.building_id = building_row.id
  JOIN pending_aggregate pending_row ON pending_row.building_id = building_row.id
  JOIN settlement_aggregate settlement_row ON settlement_row.building_id = building_row.id
  ORDER BY lower(building_row.name) COLLATE "C", building_row.id;
END;
$business_performance_invoice_cohort$;

REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.business_performance_cash_received_v1(
  p_organization_id uuid,
  p_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  building_id uuid,
  building_name text,
  cash_month date,
  cash_received numeric,
  payment_event_count integer,
  first_payment_date date,
  last_payment_date date,
  generated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_cash_received$
DECLARE
  v_building_ids uuid[];
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Cash received month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH requested_buildings AS MATERIALIZED (
    SELECT building_row.id,
           COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building') AS name
    FROM public.buildings building_row
    WHERE building_row.organization_id = p_organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual = false
      AND building_row.id = ANY(v_building_ids)
  ),
  payment_events AS MATERIALIZED (
    SELECT
      receipt_row.id,
      invoice_row.building_id,
      receipt_row.payment_date,
      receipt_row.collected_amount::numeric AS retained_cash
    FROM public.active_payment_receipts receipt_row
    JOIN public.invoices invoice_row ON invoice_row.id = receipt_row.invoice_id
    WHERE receipt_row.organization_id = p_organization_id
      AND invoice_row.organization_id = p_organization_id
      AND invoice_row.building_id = ANY(v_building_ids)
      AND receipt_row.payment_date >= p_month
      AND receipt_row.payment_date < (p_month + interval '1 month')::date
  )
  SELECT
    building_row.id,
    building_row.name,
    p_month,
    COALESCE(sum(event_row.retained_cash), 0)::numeric,
    count(event_row.id)::integer,
    min(event_row.payment_date),
    max(event_row.payment_date),
    clock_timestamp()
  FROM requested_buildings building_row
  LEFT JOIN payment_events event_row ON event_row.building_id = building_row.id
  GROUP BY building_row.id, building_row.name
  ORDER BY lower(building_row.name) COLLATE "C", building_row.id;
END;
$business_performance_cash_received$;

REVOKE ALL ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.business_performance_category_breakdown_v1(
  p_organization_id uuid,
  p_basis text,
  p_start_date date,
  p_end_date date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  month date,
  side text,
  type_id uuid,
  type_name text,
  category text,
  total_amount numeric,
  voucher_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_category_breakdown$
DECLARE
  v_building_ids uuid[];
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_basis IS NULL OR p_basis NOT IN ('ACCRUAL', 'VOUCHER_DATE') THEN
    RAISE EXCEPTION 'Unsupported business performance basis'
      USING ERRCODE = '22023';
  END IF;
  IF p_start_date IS NULL
     OR p_end_date IS NULL
     OR p_end_date < p_start_date
     OR p_end_date - p_start_date > 400 THEN
    RAISE EXCEPTION 'Invalid category breakdown date range'
      USING ERRCODE = '22023';
  END IF;

  IF p_basis = 'ACCRUAL' THEN
    RETURN QUERY
    SELECT
      allocation_row.month,
      upper(allocation_row.side),
      allocation_row.type_id,
      allocation_row.type_name,
      allocation_row.category,
      sum(allocation_row.amount)::numeric,
      count(DISTINCT allocation_row.voucher_id)::bigint
    FROM public.fa_accrual_allocations(
      p_start_date,
      p_end_date,
      v_building_ids
    ) allocation_row
    WHERE allocation_row.building_id = ANY(v_building_ids)
      AND allocation_row.is_virtual = false
    GROUP BY allocation_row.month,
             upper(allocation_row.side),
             allocation_row.type_id,
             allocation_row.type_name,
             allocation_row.category
    ORDER BY allocation_row.month,
             upper(allocation_row.side),
             sum(allocation_row.amount) DESC,
             allocation_row.type_id NULLS LAST;
  ELSE
    RETURN QUERY
    SELECT
      breakdown.month,
      upper(breakdown.side),
      breakdown.type_id,
      breakdown.type_name,
      breakdown.category,
      breakdown.total_amount,
      breakdown.voucher_count
    FROM public.fa_type_breakdown(
      p_start_date,
      p_end_date,
      v_building_ids
    ) breakdown
    ORDER BY breakdown.month,
             upper(breakdown.side),
             breakdown.total_amount DESC,
             breakdown.type_id NULLS LAST;
  END IF;
END;
$business_performance_category_breakdown$;

REVOKE ALL ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) TO authenticated;

COMMENT ON TABLE public.finance_invoice_component_manifests IS
  'Canonical invoice-component reconciliation status. Finalized issued invoices are immutable.';
COMMENT ON TABLE public.finance_invoice_component_allocations IS
  'Prospective immutable payment allocation to invoice components; historical ambiguity remains allocation_unknown.';
COMMENT ON FUNCTION public.business_performance_invoice_cohort_v1(uuid, date, uuid[]) IS
  'MONTHLY issued current-charge cohort. Carry, deposit and settlement are reported separately; incomplete allocation fails closed.';
COMMENT ON FUNCTION public.business_performance_cash_received_v1(uuid, date, uuid[]) IS
  'Actual retained payment events by payment_date, excluding reversals and debt-status cascades.';
COMMENT ON FUNCTION public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[]) IS
  'Org-bound physical KQKD category breakdown for accrual or voucher-date basis.';

COMMIT;
