-- Canonical customer-credit consumption.
--
-- Credit lots are the balance source of truth. excess_amounts remains a
-- compatibility ledger, but every new negative row is linked to exactly one
-- lot and one application. Ambiguous legacy allocations are quarantined
-- instead of being guessed.

BEGIN;

ALTER TABLE public.customer_credit_lots
  ALTER COLUMN source_collection_id DROP NOT NULL,
  ALTER COLUMN source_tender_id DROP NOT NULL;

ALTER TABLE public.customer_credit_lots
  DROP CONSTRAINT IF EXISTS customer_credit_lots_origin_check;
ALTER TABLE public.customer_credit_lots
  ADD CONSTRAINT customer_credit_lots_origin_check CHECK (
    source_collection_id IS NOT NULL
    OR (
      source_collection_id IS NULL
      AND source_tender_id IS NULL
      AND source_excess_amount_id IS NOT NULL
    )
  );

ALTER TABLE public.customer_credit_applications
  ADD COLUMN IF NOT EXISTS application_kind text NOT NULL DEFAULT 'INVOICE_DISCOUNT',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS reversed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_excess_amount_id uuid
    REFERENCES public.excess_amounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key text,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS restoration_idempotency_key text;

ALTER TABLE public.customer_credit_applications
  DROP CONSTRAINT IF EXISTS customer_credit_applications_kind_check;
ALTER TABLE public.customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_kind_check CHECK (
    application_kind IN (
      'INVOICE_DISCOUNT', 'MOVE_OUT', 'FORFEIT', 'MANUAL', 'LEGACY_BACKFILL'
    )
  );

ALTER TABLE public.customer_credit_applications
  DROP CONSTRAINT IF EXISTS customer_credit_applications_reversal_check;
ALTER TABLE public.customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_reversal_check CHECK (
    (
      reversed_at IS NULL
      AND reversed_by IS NULL
      AND reversal_excess_amount_id IS NULL
      AND reversal_idempotency_key IS NULL
      AND reversal_reason IS NULL
      AND restored_at IS NULL
      AND restored_by IS NULL
      AND restoration_idempotency_key IS NULL
    )
    OR (
      reversed_at IS NOT NULL
      AND reversed_by IS NOT NULL
      AND reversal_excess_amount_id IS NOT NULL
      AND reversal_idempotency_key IS NOT NULL
      AND reversal_reason IS NOT NULL
      AND (
        (
          restored_at IS NULL
          AND restored_by IS NULL
          AND restoration_idempotency_key IS NULL
        )
        OR (
          restored_at IS NOT NULL
          AND restored_by IS NOT NULL
          AND restoration_idempotency_key IS NOT NULL
        )
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_lots_source_excess_uq
  ON public.customer_credit_lots(source_excess_amount_id)
  WHERE source_excess_amount_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_applications_excess_uq
  ON public.customer_credit_applications(excess_amount_id)
  WHERE excess_amount_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_applications_lot_key_uq
  ON public.customer_credit_applications(credit_lot_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_applications_reversal_excess_uq
  ON public.customer_credit_applications(reversal_excess_amount_id)
  WHERE reversal_excess_amount_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_applications_lot_reversal_key_uq
  ON public.customer_credit_applications(credit_lot_id, reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_credit_lots_contract_fifo_idx
  ON public.customer_credit_lots(
    organization_id, contract_id, status, created_at, id
  );

CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_org_uq
  ON public.contracts(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_id_org_uq
  ON public.invoices(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_id_org_uq
  ON public.payments(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS excess_amounts_id_org_uq
  ON public.excess_amounts(id, organization_id);

ALTER TABLE public.customer_credit_lots
  DROP CONSTRAINT IF EXISTS customer_credit_lots_contract_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_lots_collection_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_lots_tender_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_lots_payment_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_lots_excess_org_fkey;
ALTER TABLE public.customer_credit_lots
  ADD CONSTRAINT customer_credit_lots_contract_org_fkey
    FOREIGN KEY (contract_id, organization_id)
    REFERENCES public.contracts(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_lots_collection_org_fkey
    FOREIGN KEY (source_collection_id, organization_id)
    REFERENCES public.invoice_payment_collections(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_lots_tender_org_fkey
    FOREIGN KEY (source_tender_id, organization_id)
    REFERENCES public.invoice_payment_tenders(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_lots_payment_org_fkey
    FOREIGN KEY (source_payment_id, organization_id)
    REFERENCES public.payments(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_lots_excess_org_fkey
    FOREIGN KEY (source_excess_amount_id, organization_id)
    REFERENCES public.excess_amounts(id, organization_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.customer_credit_applications
  DROP CONSTRAINT IF EXISTS customer_credit_applications_lot_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_applications_invoice_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_applications_excess_org_fkey,
  DROP CONSTRAINT IF EXISTS customer_credit_applications_reversal_excess_org_fkey;
ALTER TABLE public.customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_lot_org_fkey
    FOREIGN KEY (credit_lot_id, organization_id)
    REFERENCES public.customer_credit_lots(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_applications_invoice_org_fkey
    FOREIGN KEY (invoice_id, organization_id)
    REFERENCES public.invoices(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_applications_excess_org_fkey
    FOREIGN KEY (excess_amount_id, organization_id)
    REFERENCES public.excess_amounts(id, organization_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT customer_credit_applications_reversal_excess_org_fkey
    FOREIGN KEY (reversal_excess_amount_id, organization_id)
    REFERENCES public.excess_amounts(id, organization_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.customer_credit_lots
  VALIDATE CONSTRAINT customer_credit_lots_contract_org_fkey;
ALTER TABLE public.customer_credit_lots
  VALIDATE CONSTRAINT customer_credit_lots_collection_org_fkey;
ALTER TABLE public.customer_credit_lots
  VALIDATE CONSTRAINT customer_credit_lots_tender_org_fkey;
ALTER TABLE public.customer_credit_lots
  VALIDATE CONSTRAINT customer_credit_lots_payment_org_fkey;
ALTER TABLE public.customer_credit_lots
  VALIDATE CONSTRAINT customer_credit_lots_excess_org_fkey;
ALTER TABLE public.customer_credit_applications
  VALIDATE CONSTRAINT customer_credit_applications_lot_org_fkey;
ALTER TABLE public.customer_credit_applications
  VALIDATE CONSTRAINT customer_credit_applications_invoice_org_fkey;
ALTER TABLE public.customer_credit_applications
  VALIDATE CONSTRAINT customer_credit_applications_excess_org_fkey;
ALTER TABLE public.customer_credit_applications
  VALIDATE CONSTRAINT customer_credit_applications_reversal_excess_org_fkey;

CREATE TABLE IF NOT EXISTS public.accounting_integrity_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  exception_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  CONSTRAINT accounting_integrity_exceptions_status_check
    CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_integrity_exceptions_open_uq
  ON public.accounting_integrity_exceptions(entity_type, entity_id, exception_code)
  WHERE status = 'OPEN';

-- Every positive compatibility row is a distinct historical credit origin.
-- Negative rows use deterministic FIFO. A matching source_payment_id narrows
-- the source set when present; one legacy row is split across lots when needed
-- while preserving its total amount and provenance.
DO $$
DECLARE
  v_positive record;
  v_negative record;
  v_contract_org uuid;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_lot_id uuid;
  v_excess_id uuid;
  v_application_id uuid;
  v_reversal_excess_id uuid;
  v_available numeric(15,2);
  v_payment_available numeric(15,2);
  v_needed numeric(15,2);
  v_take numeric(15,2);
  v_new_remaining numeric(15,2);
  v_part integer;
  v_use_payment_scope boolean;
  v_split_rows jsonb;
BEGIN
  PERFORM app_private.begin_accounting_chain_write_v1();

  FOR v_positive IN
    SELECT excess.*
    FROM public.excess_amounts excess
    JOIN public.contracts contract_row ON contract_row.id = excess.contract_id
    WHERE excess.credit_lot_id IS NULL
      AND excess.amount > 0
    ORDER BY excess.created_at, excess.id
    FOR UPDATE OF excess
  LOOP
    SELECT contract_row.organization_id INTO v_contract_org
    FROM public.contracts contract_row
    WHERE contract_row.id = v_positive.contract_id;

    IF v_contract_org IS NULL
       OR v_positive.organization_id IS DISTINCT FROM v_contract_org THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        COALESCE(v_contract_org, v_positive.organization_id),
        'EXCESS_AMOUNT', v_positive.id,
        'AMBIGUOUS_LEGACY_CUSTOMER_CREDIT',
        jsonb_build_object('reason', 'ORGANIZATION_MISMATCH')
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF (
      v_positive.source_invoice_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.invoices invoice_row
        WHERE invoice_row.id = v_positive.source_invoice_id
          AND invoice_row.organization_id = v_contract_org
      )
    ) OR (
      v_positive.source_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.payments payment_row
        WHERE payment_row.id = v_positive.source_payment_id
          AND payment_row.organization_id = v_contract_org
      )
    ) THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_contract_org, 'EXCESS_AMOUNT', v_positive.id,
        'AMBIGUOUS_LEGACY_CUSTOMER_CREDIT',
        jsonb_build_object('reason', 'SOURCE_PROVENANCE_ORGANIZATION_MISMATCH')
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    SELECT lot.id INTO v_lot_id
    FROM public.customer_credit_lots lot
    WHERE lot.source_excess_amount_id = v_positive.id
      AND lot.organization_id = v_contract_org
      AND lot.contract_id = v_positive.contract_id
    FOR UPDATE;

    IF v_lot_id IS NULL THEN
      INSERT INTO public.customer_credit_lots (
        organization_id, contract_id, source_collection_id, source_tender_id,
        source_payment_id, source_excess_amount_id, amount, remaining_amount,
        status, created_at
      ) VALUES (
        v_contract_org, v_positive.contract_id, NULL, NULL,
        v_positive.source_payment_id, v_positive.id,
        v_positive.amount, v_positive.amount, 'ACTIVE', v_positive.created_at
      ) RETURNING id INTO v_lot_id;
    END IF;

    UPDATE public.excess_amounts
       SET organization_id = v_contract_org,
           credit_lot_id = v_lot_id
     WHERE id = v_positive.id;
  END LOOP;

  FOR v_negative IN
    SELECT excess.*, source_invoice.deleted_at AS source_invoice_deleted_at
    FROM public.excess_amounts excess
    JOIN public.contracts contract_row ON contract_row.id = excess.contract_id
    LEFT JOIN public.invoices source_invoice
      ON source_invoice.id = excess.source_invoice_id
    WHERE excess.credit_lot_id IS NULL
      AND excess.amount < 0
    ORDER BY excess.created_at, excess.id
    FOR UPDATE OF excess
  LOOP
    SELECT contract_row.organization_id INTO v_contract_org
    FROM public.contracts contract_row
    WHERE contract_row.id = v_negative.contract_id;

    IF v_contract_org IS NULL
       OR v_negative.organization_id IS DISTINCT FROM v_contract_org THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        COALESCE(v_contract_org, v_negative.organization_id),
        'EXCESS_AMOUNT', v_negative.id,
        'AMBIGUOUS_LEGACY_CUSTOMER_CREDIT',
        jsonb_build_object('reason', 'ORGANIZATION_MISMATCH')
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF (
      v_negative.source_invoice_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.invoices invoice_row
        WHERE invoice_row.id = v_negative.source_invoice_id
          AND invoice_row.organization_id = v_contract_org
      )
    ) OR (
      v_negative.source_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.payments payment_row
        WHERE payment_row.id = v_negative.source_payment_id
          AND payment_row.organization_id = v_contract_org
      )
    ) THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_contract_org, 'EXCESS_AMOUNT', v_negative.id,
        'AMBIGUOUS_LEGACY_CUSTOMER_CREDIT',
        jsonb_build_object('reason', 'SOURCE_PROVENANCE_ORGANIZATION_MISMATCH')
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    PERFORM 1
    FROM public.contracts contract_row
    WHERE contract_row.id = v_negative.contract_id
    FOR UPDATE;

    SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
      INTO v_payment_available
    FROM public.customer_credit_lots lot
    WHERE lot.organization_id = v_contract_org
      AND lot.contract_id = v_negative.contract_id
      AND lot.source_payment_id = v_negative.source_payment_id
      AND lot.status <> 'REVERSED'
      AND lot.created_at <= v_negative.created_at
      AND lot.remaining_amount > 0;

    v_use_payment_scope := v_negative.source_payment_id IS NOT NULL
      AND v_payment_available > 0;

    SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
      INTO v_available
    FROM public.customer_credit_lots lot
    WHERE lot.organization_id = v_contract_org
      AND lot.contract_id = v_negative.contract_id
      AND lot.status <> 'REVERSED'
      AND lot.created_at <= v_negative.created_at
      AND lot.remaining_amount > 0
      AND (
        NOT v_use_payment_scope
        OR lot.source_payment_id = v_negative.source_payment_id
      );

    v_needed := -v_negative.amount;
    IF v_available < v_needed THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_contract_org, 'EXCESS_AMOUNT', v_negative.id,
        'AMBIGUOUS_LEGACY_CUSTOMER_CREDIT',
        jsonb_build_object(
          'reason', 'FIFO_SOURCE_TOTAL_INSUFFICIENT',
          'amount', v_negative.amount,
          'source_payment_id', v_negative.source_payment_id,
          'payment_scoped', v_use_payment_scope,
          'available_amount', v_available
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    v_part := 0;
    v_split_rows := '[]'::jsonb;
    FOR v_lot IN
      SELECT lot.*
      FROM public.customer_credit_lots lot
      WHERE lot.organization_id = v_contract_org
        AND lot.contract_id = v_negative.contract_id
        AND lot.status <> 'REVERSED'
        AND lot.created_at <= v_negative.created_at
        AND lot.remaining_amount > 0
        AND (
          NOT v_use_payment_scope
          OR lot.source_payment_id = v_negative.source_payment_id
        )
      ORDER BY lot.created_at, lot.source_excess_amount_id, lot.id
      FOR UPDATE
    LOOP
      EXIT WHEN v_needed <= 0;
      v_part := v_part + 1;
      v_take := LEAST(v_lot.remaining_amount, v_needed);
      v_new_remaining := v_lot.remaining_amount - v_take;

      IF v_part = 1 THEN
        UPDATE public.excess_amounts
           SET organization_id = v_contract_org,
               amount = -v_take,
               credit_lot_id = v_lot.id
         WHERE id = v_negative.id
         RETURNING id INTO v_excess_id;
      ELSE
        INSERT INTO public.excess_amounts (
          id, organization_id, user_id, contract_id, amount, description,
          source_invoice_id, source_payment_id, credit_lot_id, created_at
        ) VALUES (
          gen_random_uuid(), v_contract_org, v_negative.user_id,
          v_negative.contract_id, -v_take,
          COALESCE(v_negative.description, 'Legacy customer credit application')
            || ' [FIFO split from ' || v_negative.id::text || ']',
          v_negative.source_invoice_id, v_negative.source_payment_id, v_lot.id,
          v_negative.created_at + ((v_part - 1) * interval '1 microsecond')
        ) RETURNING id INTO v_excess_id;
      END IF;

      INSERT INTO public.customer_credit_applications (
        organization_id, credit_lot_id, invoice_id, excess_amount_id,
        amount, applied_by, applied_at, application_kind,
        idempotency_key, description
      ) VALUES (
        v_contract_org, v_lot.id, v_negative.source_invoice_id, v_excess_id,
        v_take, v_negative.user_id,
        v_negative.created_at + ((v_part - 1) * interval '1 microsecond'),
        'LEGACY_BACKFILL', 'legacy-credit-' || v_excess_id::text,
        COALESCE(v_negative.description, 'Legacy customer credit application')
      ) RETURNING id INTO v_application_id;

      UPDATE public.customer_credit_lots
         SET remaining_amount = v_new_remaining,
             status = CASE WHEN v_new_remaining = 0 THEN 'CONSUMED' ELSE 'ACTIVE' END
       WHERE id = v_lot.id;

      IF v_negative.source_invoice_deleted_at IS NOT NULL THEN
        INSERT INTO public.excess_amounts (
          organization_id, user_id, contract_id, amount, description,
          source_invoice_id, source_payment_id, credit_lot_id, created_at
        ) VALUES (
          v_contract_org, v_negative.user_id, v_negative.contract_id, v_take,
          '[Accounting repair] Restore credit from deleted invoice application',
          v_negative.source_invoice_id, NULL, v_lot.id,
          v_negative.source_invoice_deleted_at
        ) RETURNING id INTO v_reversal_excess_id;

        UPDATE public.customer_credit_applications application_row
           SET reversed_at = v_negative.source_invoice_deleted_at,
               reversed_by = v_negative.user_id,
               reversal_excess_amount_id = v_reversal_excess_id,
               reversal_idempotency_key =
                 'legacy-deleted-invoice-' || v_excess_id::text,
               reversal_reason =
                 'Source invoice was soft-deleted after legacy credit application'
         WHERE application_row.id = v_application_id;

        UPDATE public.customer_credit_lots lot
           SET remaining_amount = lot.remaining_amount + v_take,
               status = 'ACTIVE'
         WHERE lot.id = v_lot.id;

        INSERT INTO public.accounting_repair_audit (
          organization_id, entity_type, entity_id, repair_code,
          before_snapshot, after_snapshot, details
        ) VALUES (
          v_contract_org, 'EXCESS_AMOUNT', v_excess_id,
          'CUSTOMER_CREDIT_DELETED_INVOICE_REVERSAL',
          to_jsonb(v_negative),
          jsonb_build_object(
            'application_id', v_application_id,
            'reversal_excess_amount_id', v_reversal_excess_id,
            'reversed_at', v_negative.source_invoice_deleted_at
          ),
          jsonb_build_object(
            'source_invoice_id', v_negative.source_invoice_id,
            'amount', v_take
          )
        ) ON CONFLICT DO NOTHING;
      END IF;

      v_split_rows := v_split_rows || jsonb_build_array(jsonb_build_object(
        'excess_amount_id', v_excess_id,
        'credit_lot_id', v_lot.id,
        'amount', -v_take,
        'reversed_with_deleted_invoice',
          v_negative.source_invoice_deleted_at IS NOT NULL
      ));
      v_needed := v_needed - v_take;
    END LOOP;

    IF v_needed <> 0 THEN
      RAISE EXCEPTION 'Legacy credit FIFO split did not balance'
        USING ERRCODE = '55000';
    END IF;

    IF v_part > 1 THEN
      INSERT INTO public.accounting_repair_audit (
        organization_id, entity_type, entity_id, repair_code,
        before_snapshot, after_snapshot, details
      ) VALUES (
        v_contract_org, 'EXCESS_AMOUNT', v_negative.id,
        'CUSTOMER_CREDIT_FIFO_SPLIT', to_jsonb(v_negative),
        jsonb_build_object('split_rows', v_split_rows),
        jsonb_build_object(
          'original_amount', v_negative.amount,
          'part_count', v_part,
          'payment_scoped', v_use_payment_scope
        )
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  PERFORM app_private.end_accounting_chain_write_v1();
END;
$$;

CREATE OR REPLACE FUNCTION app_private.guard_customer_credit_ledger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_sensitive boolean;
BEGIN
  v_sensitive := CASE TG_OP
    WHEN 'INSERT' THEN NEW.credit_lot_id IS NOT NULL OR NEW.amount < 0
    WHEN 'UPDATE' THEN
      OLD.credit_lot_id IS NOT NULL OR NEW.credit_lot_id IS NOT NULL
      OR OLD.amount < 0 OR NEW.amount < 0
    ELSE OLD.credit_lot_id IS NOT NULL OR OLD.amount < 0
  END;

  IF v_sensitive AND NOT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Customer credit ledger rows are core-writer only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_customer_credit_ledger_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a00_customer_credit_ledger_guard
  ON public.excess_amounts;
CREATE TRIGGER a00_customer_credit_ledger_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.excess_amounts
FOR EACH ROW EXECUTE FUNCTION app_private.guard_customer_credit_ledger_v1();

REVOKE INSERT, UPDATE, DELETE ON public.excess_amounts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_invoice_credit_lifecycle_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_lifecycle_change boolean;
BEGIN
  v_lifecycle_change := NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR (NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED')
    OR (OLD.status = 'CANCELLED' AND NEW.status IS DISTINCT FROM 'CANCELLED');

  IF v_lifecycle_change AND EXISTS (
    SELECT 1
    FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = OLD.id
  ) AND NOT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Invoice credit lifecycle changes are core-writer only'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_invoice_credit_lifecycle_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a00_invoice_credit_lifecycle_guard
  ON public.invoices;
CREATE TRIGGER a00_invoice_credit_lifecycle_guard
BEFORE UPDATE OF status, deleted_at ON public.invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_invoice_credit_lifecycle_v1();

INSERT INTO app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, reason
) VALUES (
  'customer.credit.apply.v1', 'invoices', 'MONEY', 'SHADOW',
  'Locked FIFO customer credit application with lot lifecycle'
)
ON CONFLICT (feature_key) DO UPDATE
SET domain = EXCLUDED.domain,
    risk_class = EXCLUDED.risk_class,
    reason = EXCLUDED.reason,
    updated_at = now();

INSERT INTO app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, reason
)
VALUES (
  'customer.credit.reverse.v1', 'invoices', 'MONEY', 'SHADOW',
  'Customer-credit unwind route independent from forward canary caps'
)
ON CONFLICT (feature_key) DO UPDATE
SET domain = EXCLUDED.domain,
    risk_class = EXCLUDED.risk_class,
    reason = EXCLUDED.reason,
    updated_at = now();

CREATE OR REPLACE FUNCTION app_private.apply_customer_credit_fifo_v1(
  p_actor uuid,
  p_contract_id uuid,
  p_amount numeric,
  p_invoice_id uuid,
  p_application_kind text,
  p_description text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_kind text := upper(btrim(COALESCE(p_application_kind, '')));
  v_description text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_org uuid;
  v_building_id uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_available numeric(15,2) := 0;
  v_ledger_balance numeric(15,2) := 0;
  v_requested numeric(15,2);
  v_remaining numeric(15,2);
  v_take numeric(15,2);
  v_new_remaining numeric(15,2);
  v_lot public.customer_credit_lots%ROWTYPE;
  v_excess_id uuid;
  v_application_id uuid;
  v_applications jsonb := '[]'::jsonb;
  v_response jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Invalid credit actor' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_kind NOT IN ('INVOICE_DISCOUNT', 'MOVE_OUT', 'FORFEIT', 'MANUAL') THEN
    RAISE EXCEPTION 'Invalid customer credit application kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NOT NULL AND (
    p_amount = 'NaN'::numeric OR p_amount <= 0
    OR p_amount IS DISTINCT FROM round(p_amount, 2)
  ) THEN
    RAISE EXCEPTION 'Credit amount must be positive with at most two decimals'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL AND v_kind <> 'FORFEIT' THEN
    RAISE EXCEPTION 'Only FORFEIT may consume the full balance'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id, room_row.building_id, contract_row.user_id
    INTO v_org, v_building_id, v_owner
  FROM public.contracts contract_row
  JOIN public.rooms room_row
    ON room_row.id = contract_row.room_id AND room_row.deleted_at IS NULL
  JOIN public.buildings building_row
    ON building_row.id = room_row.building_id
   AND building_row.deleted_at IS NULL
   AND building_row.organization_id = contract_row.organization_id
  JOIN public.organizations organization_row
    ON organization_row.id = contract_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract is outside an active organization'
      USING ERRCODE = '42501';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    PERFORM 1
    FROM public.invoices invoice_row
    WHERE invoice_row.id = p_invoice_id
      AND invoice_row.contract_id = p_contract_id
      AND invoice_row.organization_id = v_org
      AND invoice_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Credit target invoice does not belong to the contract'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    p_actor, v_org, 'excess_amounts.edit', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Missing permission to apply customer credit'
      USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'organization_id', v_org,
    'contract_id', p_contract_id,
    'amount', p_amount,
    'invoice_id', p_invoice_id,
    'application_kind', v_kind,
    'description', v_description
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'customer.credit.apply.v1',
    p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-'),
    p_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'customer.credit.apply.v1'
    AND operation_row.subject_scope =
      p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
    AND operation_row.actor_id = p_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('customer.credit.apply.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Customer credit writer is not enabled'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.contract_id = p_contract_id
      AND excess.credit_lot_id IS NULL
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy customer credit requires manual reconciliation'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0
  ORDER BY lot.created_at, lot.id
  FOR UPDATE;

  SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
    INTO v_available
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0;

  SELECT COALESCE(sum(excess.amount), 0)::numeric(15,2)
    INTO v_ledger_balance
  FROM public.excess_amounts excess
  WHERE excess.organization_id = v_org
    AND excess.contract_id = p_contract_id
    AND excess.credit_lot_id IS NOT NULL;

  IF abs(v_available - v_ledger_balance) >= 0.01 THEN
    RAISE EXCEPTION 'Credit lot balance does not match the compatibility ledger'
      USING ERRCODE = '55000';
  END IF;

  v_requested := CASE
    WHEN p_amount IS NULL THEN v_available
    ELSE round(p_amount, 2)
  END;

  IF v_requested > v_available THEN
    RAISE EXCEPTION 'Insufficient customer credit: requested %, available %',
      v_requested, v_available USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.claim_feature_operation_v1(
    'customer.credit.apply.v1',
    v_org,
    p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-'),
    p_actor,
    v_key,
    v_requested
  );

  IF v_requested = 0 THEN
    v_response := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', p_invoice_id,
      'application_kind', v_kind,
      'applied_amount', 0,
      'remaining_amount', v_available,
      'applications', '[]'::jsonb
    );
    UPDATE app_private.canonical_write_operations
       SET subject_id = COALESCE(p_invoice_id, p_contract_id),
           completed_at = clock_timestamp(),
           response_payload = v_response
     WHERE organization_id = v_org
       AND operation = 'customer.credit.apply.v1'
       AND subject_scope =
         p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
       AND actor_id = p_actor
       AND idempotency_key = v_key;
    RETURN v_response;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  v_remaining := v_requested;

  FOR v_lot IN
    SELECT *
    FROM public.customer_credit_lots lot
    WHERE lot.organization_id = v_org
      AND lot.contract_id = p_contract_id
      AND lot.status = 'ACTIVE'
      AND lot.remaining_amount > 0
    ORDER BY lot.created_at, lot.id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.remaining_amount, v_remaining);
    v_new_remaining := v_lot.remaining_amount - v_take;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, p_contract_id, -v_take,
      COALESCE(v_description, 'Customer credit application'),
      p_invoice_id, NULL, v_lot.id
    ) RETURNING id INTO v_excess_id;

    INSERT INTO public.customer_credit_applications (
      organization_id, credit_lot_id, invoice_id, excess_amount_id,
      amount, applied_by, application_kind, idempotency_key, description
    ) VALUES (
      v_org, v_lot.id, p_invoice_id, v_excess_id,
      v_take, p_actor, v_kind, v_key, v_description
    ) RETURNING id INTO v_application_id;

    UPDATE public.customer_credit_lots
       SET remaining_amount = v_new_remaining,
           status = CASE WHEN v_new_remaining = 0 THEN 'CONSUMED' ELSE 'ACTIVE' END
     WHERE id = v_lot.id;

    v_applications := v_applications || jsonb_build_array(jsonb_build_object(
      'application_id', v_application_id,
      'credit_lot_id', v_lot.id,
      'excess_amount_id', v_excess_id,
      'amount', v_take
    ));
    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'FIFO credit allocation did not balance'
      USING ERRCODE = '55000';
  END IF;

  v_response := jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id', p_invoice_id,
    'application_kind', v_kind,
    'applied_amount', v_requested,
    'remaining_amount', v_available - v_requested,
    'applications', v_applications
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = COALESCE(p_invoice_id, p_contract_id),
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'customer.credit.apply.v1'
     AND subject_scope =
       p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
     AND actor_id = p_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION app_private.apply_customer_credit_fifo_v1(
  uuid, uuid, numeric, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_customer_credit_v1(
  p_contract_id uuid,
  p_amount numeric,
  p_invoice_id uuid,
  p_application_kind text,
  p_description text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT app_private.apply_customer_credit_fifo_v1(
    auth.uid(), p_contract_id, p_amount, p_invoice_id,
    p_application_kind, p_description, p_idempotency_key
  );
$$;

REVOKE ALL ON FUNCTION public.apply_customer_credit_v1(
  uuid, numeric, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.reverse_customer_credit_application_lifo_v1(
  p_actor uuid,
  p_application_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_contract_id uuid;
  v_org uuid;
  v_building_id uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_application public.customer_credit_applications%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_latest_application_id uuid;
  v_ledger_balance numeric(15,2);
  v_new_remaining numeric(15,2);
  v_reversal_excess_id uuid;
  v_response jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Invalid credit reversal actor' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Credit reversal reason must contain 8-1000 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT lot.contract_id INTO v_contract_id
  FROM public.customer_credit_applications application_row
  JOIN public.customer_credit_lots lot ON lot.id = application_row.credit_lot_id
  WHERE application_row.id = p_application_id;

  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit application not found' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.organization_id, room_row.building_id, contract_row.user_id
    INTO v_org, v_building_id, v_owner
  FROM public.contracts contract_row
  JOIN public.rooms room_row
    ON room_row.id = contract_row.room_id AND room_row.deleted_at IS NULL
  JOIN public.buildings building_row
    ON building_row.id = room_row.building_id
   AND building_row.deleted_at IS NULL
   AND building_row.organization_id = contract_row.organization_id
  JOIN public.organizations organization_row
    ON organization_row.id = contract_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE contract_row.id = v_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract is outside an active organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_application
  FROM public.customer_credit_applications application_row
  WHERE application_row.id = p_application_id
  FOR UPDATE;

  SELECT * INTO v_lot
  FROM public.customer_credit_lots lot
  WHERE lot.id = v_application.credit_lot_id
    AND lot.organization_id = v_org
    AND lot.contract_id = v_contract_id
  FOR UPDATE;

  IF v_lot.id IS NULL OR v_application.organization_id <> v_org THEN
    RAISE EXCEPTION 'Credit application tenant chain is invalid'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    p_actor, v_org, 'excess_amounts.edit', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Missing permission to reverse customer credit'
      USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'application_id', p_application_id,
    'reason', v_reason
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'customer.credit.reverse.v1', p_application_id::text,
    p_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'customer.credit.reverse.v1'
    AND operation_row.subject_scope = p_application_id::text
    AND operation_row.actor_id = p_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('customer.credit.reverse.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Customer credit writer is not enabled'
      USING ERRCODE = '55000';
  END IF;

  IF v_application.reversed_at IS NOT NULL THEN
    IF v_application.reversal_idempotency_key IS DISTINCT FROM v_key THEN
      RAISE EXCEPTION 'Customer credit application was already reversed'
        USING ERRCODE = '23505';
    END IF;

    v_response := jsonb_build_object(
      'application_id', v_application.id,
      'credit_lot_id', v_application.credit_lot_id,
      'reversal_excess_amount_id', v_application.reversal_excess_amount_id,
      'reversed_amount', v_application.amount,
      'remaining_amount', v_lot.remaining_amount,
      'noop', true
    );
    UPDATE app_private.canonical_write_operations
       SET subject_id = v_application.id,
           completed_at = clock_timestamp(),
           response_payload = v_response
     WHERE organization_id = v_org
       AND operation = 'customer.credit.reverse.v1'
       AND subject_scope = p_application_id::text
       AND actor_id = p_actor
       AND idempotency_key = v_key;
    RETURN v_response;
  END IF;

  SELECT application_row.id INTO v_latest_application_id
  FROM public.customer_credit_applications application_row
  JOIN public.customer_credit_lots lot
    ON lot.id = application_row.credit_lot_id
  WHERE lot.organization_id = v_org
    AND lot.contract_id = v_contract_id
    AND application_row.reversed_at IS NULL
  ORDER BY application_row.applied_at DESC, application_row.id DESC
  LIMIT 1
  FOR UPDATE OF application_row;

  IF v_latest_application_id IS DISTINCT FROM p_application_id THEN
    RAISE EXCEPTION 'Customer credit applications must be reversed in LIFO order'
      USING ERRCODE = '55000';
  END IF;
  IF v_lot.status = 'REVERSED'
     OR v_lot.remaining_amount + v_application.amount > v_lot.amount THEN
    RAISE EXCEPTION 'Credit lot cannot absorb the application reversal'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(sum(excess.amount), 0)::numeric(15,2)
    INTO v_ledger_balance
  FROM public.excess_amounts excess
  WHERE excess.organization_id = v_org
    AND excess.credit_lot_id = v_lot.id;
  IF abs(v_ledger_balance - v_lot.remaining_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Credit lot balance does not match the compatibility ledger'
      USING ERRCODE = '55000';
  END IF;

  v_new_remaining := v_lot.remaining_amount + v_application.amount;
  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.excess_amounts (
    organization_id, user_id, contract_id, amount, description,
    source_invoice_id, source_payment_id, credit_lot_id
  ) VALUES (
    v_org, v_owner, v_contract_id, v_application.amount,
    'Reverse customer credit: ' || v_reason,
    v_application.invoice_id, NULL, v_lot.id
  ) RETURNING id INTO v_reversal_excess_id;

  UPDATE public.customer_credit_applications
     SET reversed_at = clock_timestamp(),
         reversed_by = p_actor,
         reversal_excess_amount_id = v_reversal_excess_id,
         reversal_idempotency_key = v_key,
         reversal_reason = v_reason
   WHERE id = v_application.id;

  UPDATE public.customer_credit_lots
     SET remaining_amount = v_new_remaining,
         status = 'ACTIVE'
   WHERE id = v_lot.id;

  v_response := jsonb_build_object(
    'application_id', v_application.id,
    'credit_lot_id', v_lot.id,
    'reversal_excess_amount_id', v_reversal_excess_id,
    'reversed_amount', v_application.amount,
    'remaining_amount', v_new_remaining,
    'noop', false
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_application.id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'customer.credit.reverse.v1'
     AND subject_scope = p_application_id::text
     AND actor_id = p_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION app_private.reverse_customer_credit_application_lifo_v1(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reverse_customer_credit_application_v1(
  p_application_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT app_private.reverse_customer_credit_application_lifo_v1(
    auth.uid(), p_application_id, p_reason, p_idempotency_key
  );
$$;

REVOKE ALL ON FUNCTION public.reverse_customer_credit_application_v1(
  uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.reverse_invoice_customer_credit_v1(
  p_actor uuid,
  p_invoice_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_application record;
  v_child_key text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_total numeric(15,2) := 0;
BEGIN
  FOR v_application IN
    SELECT application_row.id, application_row.amount
    FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
      AND application_row.reversed_at IS NULL
    ORDER BY application_row.applied_at DESC, application_row.id DESC
  LOOP
    v_child_key := left(p_idempotency_key, 150)
      || ':app:' || replace(v_application.id::text, '-', '');
    v_result := app_private.reverse_customer_credit_application_lifo_v1(
      p_actor, v_application.id, p_reason, v_child_key
    );
    v_total := v_total + v_application.amount;
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'reversed_amount', v_total,
    'applications', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION app_private.reverse_invoice_customer_credit_v1(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_invoice_with_credit_v1(
  p_contract_id uuid,
  p_building_id uuid,
  p_room_id uuid,
  p_billing_month text,
  p_issue_date date,
  p_due_date date,
  p_kind text,
  p_subtotal numeric,
  p_discount_amount numeric,
  p_total_amount numeric,
  p_previous_debt numeric,
  p_items jsonb,
  p_idempotency_key text,
  p_prepaid_amount numeric DEFAULT 0,
  p_discount_notes text DEFAULT NULL,
  p_electricity_prev_overridden boolean DEFAULT false,
  p_previous_debt_sources jsonb DEFAULT '[]'::jsonb,
  p_template_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_applied_credit numeric DEFAULT 0,
  p_non_credit_discount_amount numeric DEFAULT 0,
  p_creator_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice_result json;
  v_invoice_id uuid;
  v_credit_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_applied_credit IS NULL OR p_applied_credit = 'NaN'::numeric
     OR p_applied_credit <= 0
     OR p_applied_credit IS DISTINCT FROM round(p_applied_credit, 2) THEN
    RAISE EXCEPTION 'Applied credit must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_non_credit_discount_amount IS NULL
     OR p_non_credit_discount_amount = 'NaN'::numeric
     OR p_non_credit_discount_amount < 0
     OR p_non_credit_discount_amount IS DISTINCT FROM round(
       p_non_credit_discount_amount, 2
     )
     OR p_discount_amount IS NULL
     OR p_discount_amount IS DISTINCT FROM round(p_discount_amount, 2)
     OR round(p_discount_amount, 2) IS DISTINCT FROM round(
       p_non_credit_discount_amount + p_applied_credit, 2
     ) THEN
    RAISE EXCEPTION
      'Invoice discount must equal non-credit discount plus applied credit'
      USING ERRCODE = '22023';
  END IF;

  v_invoice_result := public.create_invoice_v1(
    p_contract_id, p_building_id, p_room_id, p_billing_month,
    p_issue_date, p_due_date, p_kind, p_subtotal, p_discount_amount,
    p_total_amount, p_previous_debt, p_items, v_key, p_prepaid_amount,
    p_discount_notes, p_electricity_prev_overridden,
    p_previous_debt_sources, p_template_id, p_notes, 0, p_creator_name
  );
  v_invoice_id := NULLIF(v_invoice_result->>'invoice_id', '')::uuid;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'create_invoice_v1 returned no invoice_id'
      USING ERRCODE = '55000';
  END IF;

  v_credit_result := app_private.apply_customer_credit_fifo_v1(
    v_actor, p_contract_id, round(p_applied_credit, 2), v_invoice_id,
    'INVOICE_DISCOUNT',
    'Apply customer credit to invoice ' ||
      COALESCE(v_invoice_result->>'invoice_number', v_invoice_id::text),
    v_key
  );

  RETURN to_jsonb(v_invoice_result) || jsonb_build_object('credit', v_credit_result);
END;
$$;

REVOKE ALL ON FUNCTION public.create_invoice_with_credit_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric,
  numeric, jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric,
  numeric, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_invoice_with_credit_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric,
  numeric, jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric,
  numeric, text
) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.contract_customer_credit_balance_v1(
  p_contract_id uuid,
  p_organization_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_balance numeric(15,2);
  v_ledger_balance numeric(15,2);
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.contracts contract_row
    WHERE contract_row.id = p_contract_id
      AND contract_row.organization_id = p_organization_id
      AND contract_row.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Contract tenant chain is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.organization_id = p_organization_id
      AND excess.contract_id = p_contract_id
      AND excess.credit_lot_id IS NULL
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy customer credit requires manual reconciliation'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
    INTO v_balance
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = p_organization_id
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0;

  SELECT COALESCE(sum(excess.amount), 0)::numeric(15,2)
    INTO v_ledger_balance
  FROM public.excess_amounts excess
  WHERE excess.organization_id = p_organization_id
    AND excess.contract_id = p_contract_id
    AND excess.credit_lot_id IS NOT NULL;

  IF v_ledger_balance IS DISTINCT FROM v_balance THEN
    RAISE EXCEPTION 'Credit lot balance does not match the compatibility ledger'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION app_private.contract_customer_credit_balance_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.assert_contract_has_no_customer_credit_v1(
  p_contract_id uuid,
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_balance numeric(15,2);
BEGIN
  v_balance := app_private.contract_customer_credit_balance_v1(
    p_contract_id, p_organization_id
  );
  IF v_balance > 0 THEN
    RAISE EXCEPTION 'Contract has canonical customer credit; use the credit-aware termination RPC'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_private.assert_contract_has_no_customer_credit_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_with_credit_v1(
  p_contract_id uuid,
  p_forfeit_date date,
  p_extra_charges jsonb,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_credit_balance numeric(15,2);
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id INTO v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract not found' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'forfeit_date', p_forfeit_date,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.forfeit.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.forfeit.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_credit_balance := app_private.contract_customer_credit_balance_v1(
    p_contract_id, v_org
  );
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_forfeit(
    p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();
  IF v_credit_balance > 0 THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, NULL, NULL, 'FORFEIT',
      'Forfeit remaining customer credit on contract termination', v_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', NULL,
      'application_kind', 'FORFEIT',
      'applied_amount', 0,
      'remaining_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;
  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.forfeit.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit_with_credit_v1(
  uuid, date, jsonb, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit_with_credit_v1(
  uuid, date, jsonb, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_with_credit_v1(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric,
  p_penalty_fee numeric,
  p_excess_rent numeric,
  p_outstanding_debt numeric,
  p_notes text,
  p_extra_charges jsonb,
  p_shortfall_mode text,
  p_receipt_account_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_credit_amount numeric(15,2) := round(COALESCE(p_excess_rent, 0), 2);
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_excess_rent = 'NaN'::numeric
     OR COALESCE(p_excess_rent, 0) < 0
     OR COALESCE(p_excess_rent, 0) IS DISTINCT FROM round(
       COALESCE(p_excess_rent, 0), 2
     ) THEN
    RAISE EXCEPTION 'Move-out credit amount must be non-negative with at most two decimals'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id INTO v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract not found' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'move_out_date', p_move_out_date,
    'deposit_refund', p_deposit_refund,
    'penalty_fee', p_penalty_fee,
    'excess_rent', p_excess_rent,
    'outstanding_debt', p_outstanding_debt,
    'notes', p_notes,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb),
    'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', p_receipt_account_id
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.move_out.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.move_out.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_move_out(
    p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
    COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
    COALESCE(p_outstanding_debt, 0), p_notes,
    COALESCE(p_extra_charges, '[]'::jsonb),
    COALESCE(p_shortfall_mode, 'PAID'), p_receipt_account_id
  );
  PERFORM app_private.end_accounting_chain_write_v1();

  IF v_credit_amount > 0 THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, v_credit_amount, NULL, 'MOVE_OUT',
      'Apply customer credit during move-out settlement', v_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'application_kind', 'MOVE_OUT',
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.move_out.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out_with_credit_v1(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_with_credit_v1(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.assert_invoice_credit_cancellable_v1(
  p_invoice_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.source_invoice_id = p_invoice_id
      AND excess.credit_lot_id IS NULL
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Invoice has unreconciled legacy customer credit'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.customer_credit_lots lot
    JOIN public.excess_amounts source_excess
      ON source_excess.id = lot.source_excess_amount_id
    WHERE source_excess.source_invoice_id = p_invoice_id
      AND lot.status <> 'REVERSED'
  ) THEN
    RAISE EXCEPTION 'Reverse the payment credit source before cancelling this invoice'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_private.assert_invoice_credit_cancellable_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_invoice_with_credit_v1(
  p_invoice_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_credit jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_row.contract_id INTO v_contract_id
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;
  IF v_contract_id IS NOT NULL THEN
    PERFORM 1 FROM public.contracts contract_row
    WHERE contract_row.id = v_contract_id FOR UPDATE;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to cancel invoice'
      USING ERRCODE = '42501';
  END IF;
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'credit', NULL,
      'noop', true
    );
  END IF;

  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  v_credit := app_private.reverse_invoice_customer_credit_v1(
    v_actor, p_invoice_id, 'Cancel invoice and restore applied customer credit', v_key
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  PERFORM app_private.end_accounting_chain_write_v1();

  RETURN jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'credit', v_credit,
    'noop', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_invoice_with_credit_v1(uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_with_credit_v1(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.soft_delete_invoice_with_credit_v1(
  p_invoice_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_credit jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_row.contract_id INTO v_contract_id
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;
  IF v_contract_id IS NOT NULL THEN
    PERFORM 1 FROM public.contracts contract_row
    WHERE contract_row.id = v_contract_id FOR UPDATE;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF v_invoice.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'invoice_id', p_invoice_id,
      'credit', NULL,
      'noop', true
    );
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to delete invoice'
      USING ERRCODE = '42501';
  END IF;
  IF v_invoice.status NOT IN ('DRAFT', 'APPROVED')
     OR COALESCE(v_invoice.paid_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'Invoice cannot be deleted in its current state'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  v_credit := app_private.reverse_invoice_customer_credit_v1(
    v_actor, p_invoice_id, 'Delete invoice and restore applied customer credit', v_key
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.invoices
     SET deleted_at = clock_timestamp()
   WHERE id = p_invoice_id;
  PERFORM app_private.end_accounting_chain_write_v1();

  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'credit', v_credit,
    'noop', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_invoice_with_credit_v1(uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_invoice_with_credit_v1(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.bulk_soft_delete_invoices_with_credit_v1(
  p_invoice_ids uuid[],
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice_id uuid;
  v_child_key text;
  v_result jsonb;
  v_count integer := 0;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_invoice_ids IS NULL OR array_length(p_invoice_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('deleted_count', 0, 'invoices', '[]'::jsonb);
  END IF;

  FOR v_invoice_id IN
    SELECT requested.requested_id
    FROM (
      SELECT DISTINCT input_id AS requested_id
      FROM unnest(p_invoice_ids) AS input(input_id)
    ) requested
    LEFT JOIN LATERAL (
      SELECT application_row.applied_at, application_row.id
      FROM public.customer_credit_applications application_row
      WHERE application_row.invoice_id = requested.requested_id
        AND application_row.reversed_at IS NULL
      ORDER BY application_row.applied_at DESC, application_row.id DESC
      LIMIT 1
    ) latest_application ON true
    ORDER BY latest_application.applied_at DESC NULLS LAST,
             latest_application.id DESC NULLS LAST,
             requested.requested_id
  LOOP
    v_child_key := left(v_key, 150)
      || ':inv:' || replace(v_invoice_id::text, '-', '');
    v_result := public.soft_delete_invoice_with_credit_v1(
      v_invoice_id, v_child_key
    );
    IF NOT COALESCE((v_result->>'noop')::boolean, false) THEN
      v_count := v_count + 1;
    END IF;
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object('deleted_count', v_count, 'invoices', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_soft_delete_invoices_with_credit_v1(uuid[], text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.bulk_soft_delete_invoices_with_credit_v1(uuid[], text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.super_admin_force_cancel_invoice_with_credit_v1(
  p_invoice_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_active_payments integer;
  v_credit jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only super admins may force-cancel invoices'
      USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_row.contract_id INTO v_contract_id
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;
  IF v_contract_id IS NOT NULL THEN
    PERFORM 1 FROM public.contracts contract_row
    WHERE contract_row.id = v_contract_id FOR UPDATE;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice was already deleted' USING ERRCODE = '55000';
  END IF;
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN jsonb_build_object(
      'invoice_id', p_invoice_id,
      'status', 'CANCELLED',
      'credit', NULL,
      'noop', true
    );
  END IF;

  SELECT count(*) INTO v_active_payments
  FROM public.payments payment
  WHERE payment.invoice_id = p_invoice_id
    AND payment.reversed_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.payment_reversals reversal
      WHERE reversal.original_payment_id = payment.id
    );
  IF v_active_payments > 0 THEN
    RAISE EXCEPTION 'Invoice still has % active payments; reverse them first',
      v_active_payments USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  v_credit := app_private.reverse_invoice_customer_credit_v1(
    v_actor, p_invoice_id,
    'Force-cancel invoice and restore applied customer credit', v_key
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id;
  PERFORM app_private.end_accounting_chain_write_v1();

  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'status', 'CANCELLED',
    'credit', v_credit,
    'noop', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.super_admin_force_cancel_invoice_with_credit_v1(
  uuid, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.super_admin_force_cancel_invoice_with_credit_v1(
  uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_invoice_with_credit_v1(
  p_invoice_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_active_count integer;
  v_restore_amount numeric(15,2);
  v_restore_fingerprint text;
  v_apply_key text;
  v_credit jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_row.contract_id INTO v_contract_id
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;
  IF v_contract_id IS NOT NULL THEN
    PERFORM 1 FROM public.contracts contract_row
    WHERE contract_row.id = v_contract_id FOR UPDATE;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to restore invoice'
      USING ERRCODE = '42501';
  END IF;
  IF v_invoice.status = 'APPROVED' THEN
    RETURN jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'credit', NULL,
      'noop', true
    );
  END IF;
  IF v_invoice.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Only cancelled invoices can be restored'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.customer_credit_applications application_row
  WHERE application_row.invoice_id = p_invoice_id
    AND application_row.reversed_at IS NULL;

  SELECT COALESCE(sum(application_row.amount), 0)::numeric(15,2),
         md5(COALESCE(string_agg(
           application_row.id::text, ',' ORDER BY application_row.id
         ), ''))
    INTO v_restore_amount, v_restore_fingerprint
  FROM public.customer_credit_applications application_row
  WHERE application_row.invoice_id = p_invoice_id
    AND application_row.reversed_at IS NOT NULL
    AND application_row.restored_at IS NULL;

  IF v_active_count > 0 AND v_restore_amount > 0 THEN
    RAISE EXCEPTION 'Invoice has mixed active and pending-restoration credit applications'
      USING ERRCODE = '55000';
  END IF;

  IF v_restore_amount > 0 THEN
    IF v_contract_id IS NULL THEN
      RAISE EXCEPTION 'Credit invoice has no contract' USING ERRCODE = '55000';
    END IF;
    v_apply_key := left(v_key, 150) || ':cycle:' || v_restore_fingerprint;
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, v_contract_id, v_restore_amount, p_invoice_id,
      'INVOICE_DISCOUNT',
      'Reapply customer credit while restoring invoice', v_apply_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'invoice_id', p_invoice_id,
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  IF v_restore_amount > 0 THEN
    UPDATE public.customer_credit_applications
       SET restored_at = clock_timestamp(),
           restored_by = v_actor,
           restoration_idempotency_key = v_apply_key
     WHERE invoice_id = p_invoice_id
       AND reversed_at IS NOT NULL
       AND restored_at IS NULL;
  END IF;

  UPDATE public.invoices
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         approved_by = v_actor
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  PERFORM app_private.end_accounting_chain_write_v1();

  RETURN jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'credit', v_credit,
    'noop', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.restore_invoice_with_credit_v1(uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.restore_invoice_with_credit_v1(uuid, text)
  TO authenticated;

-- Legacy invoice lifecycle entry points remain available for non-credit
-- invoices, but fail closed as soon as any credit lifecycle row is involved.
CREATE OR REPLACE FUNCTION public.cancel_invoice_v1(p_invoice_id uuid)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to cancel invoice'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use cancel_invoice_with_credit_v1 for this invoice'
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN v_invoice;
  END IF;
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  RETURN v_invoice;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_invoice_v1(p_invoice_id uuid)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to restore invoice'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use restore_invoice_with_credit_v1 for this invoice'
      USING ERRCODE = '55000';
  END IF;
  IF v_invoice.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Only cancelled invoices can be restored'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.invoices
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         approved_by = v_actor
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  RETURN v_invoice;
END;
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_invoice_v1(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to delete invoice'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use soft_delete_invoice_with_credit_v1 for this invoice'
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  IF v_invoice.status NOT IN ('DRAFT', 'APPROVED')
     OR COALESCE(v_invoice.paid_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'Invoice cannot be deleted in its current state'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.invoices
     SET deleted_at = clock_timestamp()
   WHERE id = p_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bulk_soft_delete_invoices_v1(
  p_invoice_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice_id uuid;
  v_count integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_invoice_ids IS NULL OR array_length(p_invoice_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = ANY(p_invoice_ids)
  ) THEN
    RAISE EXCEPTION 'Use bulk_soft_delete_invoices_with_credit_v1 for this request'
      USING ERRCODE = '55000';
  END IF;
  FOR v_invoice_id IN
    SELECT DISTINCT requested.requested_id
    FROM unnest(p_invoice_ids) AS requested(requested_id)
  LOOP
    PERFORM app_private.assert_invoice_credit_cancellable_v1(v_invoice_id);
  END LOOP;
  UPDATE public.invoices invoice_row
     SET deleted_at = clock_timestamp()
   WHERE invoice_row.id = ANY(p_invoice_ids)
     AND invoice_row.deleted_at IS NULL
     AND invoice_row.status = 'DRAFT'
     AND app_private.can_edit_invoice_building_v1(invoice_row.building_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.super_admin_force_cancel_invoice_v2(
  p_invoice_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
  v_active_payments integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only super admins may force-cancel invoices'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice was already deleted' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use super_admin_force_cancel_invoice_with_credit_v1'
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN json_build_object(
      'invoice_id', p_invoice_id, 'status', 'CANCELLED', 'noop', true
    );
  END IF;
  SELECT count(*) INTO v_active_payments
  FROM public.payments payment
  WHERE payment.invoice_id = p_invoice_id
    AND payment.reversed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_private.payment_reversals reversal
      WHERE reversal.original_payment_id = payment.id
    );
  IF v_active_payments > 0 THEN
    RAISE EXCEPTION 'Invoice still has % active payments; reverse them first',
      v_active_payments USING ERRCODE = '55000';
  END IF;
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id;
  RETURN json_build_object(
    'invoice_id', p_invoice_id, 'status', 'CANCELLED', 'noop', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_invoice_v1(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_v1(uuid)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restore_invoice_v1(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_invoice_v1(uuid)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.soft_delete_invoice_v1(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_invoice_v1(uuid)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_soft_delete_invoices_v1(uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_soft_delete_invoices_v1(uuid[])
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_force_cancel_invoice_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.super_admin_force_cancel_invoice_v2(uuid)
  TO authenticated, service_role;

-- Cached clients remain usable during canary for contracts that provably have
-- no customer credit. Canonical wrappers open the transaction capability so
-- they can perform termination and credit application atomically.
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(
  p_contract_id uuid,
  p_forfeit_date date,
  p_extra_charges jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_room uuid;
  v_org uuid;
  v_core_writer boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id FROM public.rooms room_row WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
  END IF;

  RETURN public.terminate_contract_forfeit_impl(
    p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric DEFAULT 0,
  p_penalty_fee numeric DEFAULT 0,
  p_excess_rent numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_extra_charges jsonb DEFAULT '[]'::jsonb,
  p_shortfall_mode text DEFAULT 'PAID',
  p_receipt_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_room uuid;
  v_org uuid;
  v_core_writer boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id FROM public.rooms room_row WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
  END IF;

  RETURN public.terminate_contract_move_out_impl(
    p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
    COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
    COALESCE(p_outstanding_debt, 0), p_notes,
    COALESCE(p_extra_charges, '[]'::jsonb),
    COALESCE(p_shortfall_mode, 'PAID'), p_receipt_account_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_customer_credit_balance_v1(
  p_contract_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_building_id uuid;
  v_authz boolean;
  v_balance numeric(15,2);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.organization_id, room_row.building_id
    INTO v_org, v_building_id
  FROM public.contracts contract_row
  JOIN public.rooms room_row
    ON room_row.id = contract_row.room_id AND room_row.deleted_at IS NULL
  JOIN public.buildings building_row
    ON building_row.id = room_row.building_id
   AND building_row.organization_id = contract_row.organization_id
   AND building_row.deleted_at IS NULL
  JOIN public.organizations organization_row
    ON organization_row.id = contract_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract is outside an active organization'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'excess_amounts.view', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Missing permission to view customer credit'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.contract_id = p_contract_id
      AND excess.credit_lot_id IS NULL
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy customer credit requires manual reconciliation'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0
  ORDER BY lot.created_at, lot.id
  FOR SHARE;

  SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
    INTO v_balance
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0;

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_credit_balance_v1(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_credit_balance_v1(uuid)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
