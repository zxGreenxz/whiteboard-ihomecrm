-- Canonical invoice collection V5: multi-tender, server-derived accounting,
-- incremental customer credit and allocation-aware reversal.
--
-- ROLLBACK: freeze new collection writes and deploy a forward fix. Keep the
-- collection-aware v3/v4/reverse discriminators, recompute function and guards
-- for as long as any V5 row exists; restoring the old per-payment reversal can
-- corrupt a multi-tender collection. Never delete collection/reversal history.

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS collection_id uuid,
  ADD COLUMN IF NOT EXISTS tender_id uuid,
  ADD COLUMN IF NOT EXISTS received_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS credit_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS change_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounding_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_collection_id uuid;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_v5_amounts_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_v5_amounts_check CHECK (
    (received_amount IS NULL OR (
      received_amount <> 'NaN'::numeric AND received_amount >= 0
    ))
    AND credit_amount <> 'NaN'::numeric AND credit_amount >= 0
    AND change_amount <> 'NaN'::numeric AND change_amount >= 0
    AND rounding_amount <> 'NaN'::numeric AND rounding_amount >= 0
  );

ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS payment_collection_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_of_income_expense_id uuid;

ALTER TABLE public.excess_amounts
  ADD COLUMN IF NOT EXISTS credit_lot_id uuid;

CREATE TABLE IF NOT EXISTS public.invoice_payment_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES public.contracts(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE',
  collection_date date NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  expected_paid_amount numeric(15,2) NOT NULL,
  gross_amount numeric(15,2) NOT NULL,
  retained_amount numeric(15,2) NOT NULL,
  applied_amount numeric(15,2) NOT NULL,
  change_amount numeric(15,2) NOT NULL DEFAULT 0,
  credit_amount numeric(15,2) NOT NULL DEFAULT 0,
  rounding_amount numeric(15,2) NOT NULL DEFAULT 0,
  notes text,
  receipt_image_url text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_date date,
  reversal_reason text,
  reversal_idempotency_key text,
  CONSTRAINT invoice_payment_collections_status_check
    CHECK (status IN ('ACTIVE', 'REVERSED')),
  CONSTRAINT invoice_payment_collections_amounts_check CHECK (
    expected_paid_amount <> 'NaN'::numeric
    AND gross_amount <> 'NaN'::numeric
    AND retained_amount <> 'NaN'::numeric
    AND applied_amount <> 'NaN'::numeric
    AND change_amount <> 'NaN'::numeric
    AND credit_amount <> 'NaN'::numeric
    AND rounding_amount <> 'NaN'::numeric
    AND gross_amount > 0 AND retained_amount >= 0 AND applied_amount > 0
    AND change_amount >= 0 AND credit_amount >= 0 AND rounding_amount >= 0
    AND gross_amount = retained_amount + change_amount
    AND retained_amount = applied_amount + credit_amount
  ),
  CONSTRAINT invoice_payment_collections_idempotency_uq
    UNIQUE (organization_id, actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.invoice_payment_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  collection_id uuid NOT NULL REFERENCES public.invoice_payment_collections(id) ON DELETE RESTRICT,
  line_index integer NOT NULL,
  payment_method public.payment_method NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  change_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  rounding_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  gross_amount numeric(15,2) NOT NULL,
  retained_amount numeric(15,2) NOT NULL,
  applied_amount numeric(15,2) NOT NULL,
  change_amount numeric(15,2) NOT NULL DEFAULT 0,
  credit_amount numeric(15,2) NOT NULL DEFAULT 0,
  rounding_amount numeric(15,2) NOT NULL DEFAULT 0,
  payment_id uuid REFERENCES public.payments(id) ON DELETE RESTRICT,
  voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  receipt_number text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT invoice_payment_tenders_line_uq UNIQUE (collection_id, line_index),
  CONSTRAINT invoice_payment_tenders_amounts_check CHECK (
    gross_amount <> 'NaN'::numeric
    AND retained_amount <> 'NaN'::numeric
    AND applied_amount <> 'NaN'::numeric
    AND change_amount <> 'NaN'::numeric
    AND credit_amount <> 'NaN'::numeric
    AND rounding_amount <> 'NaN'::numeric
    AND gross_amount > 0 AND retained_amount >= 0 AND applied_amount >= 0
    AND change_amount >= 0 AND credit_amount >= 0 AND rounding_amount >= 0
    AND gross_amount = retained_amount + change_amount
    AND retained_amount = applied_amount + credit_amount
  )
);

CREATE TABLE IF NOT EXISTS public.invoice_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  collection_id uuid NOT NULL REFERENCES public.invoice_payment_collections(id) ON DELETE RESTRICT,
  tender_id uuid NOT NULL REFERENCES public.invoice_payment_tenders(id) ON DELETE RESTRICT,
  voucher_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  income_expense_item_id uuid NOT NULL REFERENCES public.income_expense_items(id) ON DELETE RESTRICT,
  accounting_class text NOT NULL,
  amount numeric(15,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT invoice_payment_allocations_class_check
    CHECK (accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT', 'INTERNAL')),
  CONSTRAINT invoice_payment_allocations_amount_check CHECK (
    amount <> 'NaN'::numeric AND amount > 0
  )
);

CREATE TABLE IF NOT EXISTS public.customer_credit_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
  source_collection_id uuid NOT NULL REFERENCES public.invoice_payment_collections(id) ON DELETE RESTRICT,
  source_tender_id uuid REFERENCES public.invoice_payment_tenders(id) ON DELETE RESTRICT,
  source_payment_id uuid REFERENCES public.payments(id) ON DELETE RESTRICT,
  source_excess_amount_id uuid REFERENCES public.excess_amounts(id) ON DELETE RESTRICT,
  amount numeric(15,2) NOT NULL,
  remaining_amount numeric(15,2) NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_at timestamptz,
  CONSTRAINT customer_credit_lots_source_uq UNIQUE (source_collection_id),
  CONSTRAINT customer_credit_lots_amount_check CHECK (
    amount <> 'NaN'::numeric AND remaining_amount <> 'NaN'::numeric
    AND amount > 0 AND remaining_amount >= 0 AND remaining_amount <= amount
  ),
  CONSTRAINT customer_credit_lots_status_check
    CHECK (status IN ('ACTIVE', 'CONSUMED', 'REVERSED'))
);

CREATE TABLE IF NOT EXISTS public.customer_credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  credit_lot_id uuid NOT NULL REFERENCES public.customer_credit_lots(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  excess_amount_id uuid REFERENCES public.excess_amounts(id) ON DELETE RESTRICT,
  amount numeric(15,2) NOT NULL CHECK (
    amount <> 'NaN'::numeric AND amount > 0
  ),
  applied_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_at timestamptz
);

-- Composite tenant keys make cross-organization links impossible even for a
-- privileged maintenance path that accidentally supplies a mismatched UUID.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payment_collections_id_org_uq
  ON public.invoice_payment_collections(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payment_tenders_id_org_uq
  ON public.invoice_payment_tenders(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_lots_id_org_uq
  ON public.customer_credit_lots(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS income_expenses_id_org_uq
  ON public.income_expenses(id, organization_id);

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_collection_id_fkey,
  DROP CONSTRAINT IF EXISTS payments_tender_id_fkey,
  DROP CONSTRAINT IF EXISTS payments_reversed_by_collection_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_collection_id_fkey
    FOREIGN KEY (collection_id, organization_id)
    REFERENCES public.invoice_payment_collections(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_tender_id_fkey
    FOREIGN KEY (tender_id, organization_id)
    REFERENCES public.invoice_payment_tenders(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_reversed_by_collection_id_fkey
    FOREIGN KEY (reversed_by_collection_id, organization_id)
    REFERENCES public.invoice_payment_collections(id, organization_id) ON DELETE RESTRICT;

ALTER TABLE public.income_expenses
  DROP CONSTRAINT IF EXISTS income_expenses_payment_collection_id_fkey,
  DROP CONSTRAINT IF EXISTS income_expenses_reversal_of_income_expense_id_fkey;
ALTER TABLE public.income_expenses
  ADD CONSTRAINT income_expenses_payment_collection_id_fkey
    FOREIGN KEY (payment_collection_id, organization_id)
    REFERENCES public.invoice_payment_collections(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT income_expenses_reversal_of_income_expense_id_fkey
    FOREIGN KEY (reversal_of_income_expense_id, organization_id)
    REFERENCES public.income_expenses(id, organization_id) ON DELETE RESTRICT;

ALTER TABLE public.excess_amounts
  DROP CONSTRAINT IF EXISTS excess_amounts_credit_lot_id_fkey;
ALTER TABLE public.excess_amounts
  ADD CONSTRAINT excess_amounts_credit_lot_id_fkey
    FOREIGN KEY (credit_lot_id, organization_id)
    REFERENCES public.customer_credit_lots(id, organization_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS invoice_payment_collections_invoice_idx
  ON public.invoice_payment_collections(invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_payment_collections_org_status_idx
  ON public.invoice_payment_collections(organization_id, status);
CREATE INDEX IF NOT EXISTS invoice_payment_tenders_collection_idx
  ON public.invoice_payment_tenders(collection_id, line_index);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payment_tenders_payment_uq
  ON public.invoice_payment_tenders(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payment_tenders_voucher_uq
  ON public.invoice_payment_tenders(voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_payment_allocations_collection_idx
  ON public.invoice_payment_allocations(collection_id, accounting_class);
CREATE INDEX IF NOT EXISTS invoice_payment_allocations_tender_idx
  ON public.invoice_payment_allocations(tender_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payment_allocations_item_uq
  ON public.invoice_payment_allocations(income_expense_item_id);
CREATE INDEX IF NOT EXISTS customer_credit_lots_contract_idx
  ON public.customer_credit_lots(contract_id, status, created_at);
CREATE INDEX IF NOT EXISTS customer_credit_applications_lot_idx
  ON public.customer_credit_applications(credit_lot_id, applied_at);
CREATE INDEX IF NOT EXISTS payments_active_invoice_idx
  ON public.payments(invoice_id, payment_date, created_at)
  WHERE reversed_at IS NULL;

ALTER TABLE public.invoice_payment_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payment_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_payment_collections_select ON public.invoice_payment_collections;
CREATE POLICY invoice_payment_collections_select
ON public.invoice_payment_collections FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.invoices invoice_row
    WHERE invoice_row.id = invoice_payment_collections.invoice_id
      AND public.can_access_building(invoice_row.building_id)
  )
);

DROP POLICY IF EXISTS invoice_payment_tenders_select ON public.invoice_payment_tenders;
CREATE POLICY invoice_payment_tenders_select
ON public.invoice_payment_tenders FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.invoice_payment_collections collection_row
    WHERE collection_row.id = invoice_payment_tenders.collection_id
      AND EXISTS (
        SELECT 1 FROM public.invoices invoice_row
        WHERE invoice_row.id = collection_row.invoice_id
          AND public.can_access_building(invoice_row.building_id)
      )
  )
);

DROP POLICY IF EXISTS invoice_payment_allocations_select ON public.invoice_payment_allocations;
CREATE POLICY invoice_payment_allocations_select
ON public.invoice_payment_allocations FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.invoice_payment_collections collection_row
    JOIN public.invoices invoice_row ON invoice_row.id = collection_row.invoice_id
    WHERE collection_row.id = invoice_payment_allocations.collection_id
      AND public.can_access_building(invoice_row.building_id)
  )
);

DROP POLICY IF EXISTS customer_credit_lots_select ON public.customer_credit_lots;
CREATE POLICY customer_credit_lots_select
ON public.customer_credit_lots FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.contracts contract_row
    JOIN public.rooms room_row ON room_row.id = contract_row.room_id
    WHERE contract_row.id = customer_credit_lots.contract_id
      AND public.can_access_building(room_row.building_id)
  )
);

DROP POLICY IF EXISTS customer_credit_applications_select ON public.customer_credit_applications;
CREATE POLICY customer_credit_applications_select
ON public.customer_credit_applications FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.customer_credit_lots lot
    JOIN public.contracts contract_row ON contract_row.id = lot.contract_id
    JOIN public.rooms room_row ON room_row.id = contract_row.room_id
    WHERE lot.id = customer_credit_applications.credit_lot_id
      AND public.can_access_building(room_row.building_id)
  )
);

REVOKE ALL ON public.invoice_payment_collections
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.invoice_payment_tenders
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.invoice_payment_allocations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.customer_credit_lots
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.customer_credit_applications
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.invoice_payment_collections TO authenticated;
GRANT SELECT ON public.invoice_payment_tenders TO authenticated;
GRANT SELECT ON public.invoice_payment_allocations TO authenticated;
GRANT SELECT ON public.customer_credit_lots TO authenticated;
GRANT SELECT ON public.customer_credit_applications TO authenticated;

CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric(15,2);
  v_paid numeric(15,2);
  v_rounding numeric(15,2);
  v_legacy_rounding numeric(15,2);
  v_legacy_refunded numeric(15,2);
  v_settlement_refunded numeric(15,2);
  v_has_v5_payment boolean;
  v_existing_status public.invoice_status;
  v_status public.invoice_status;
  v_paid_date date;
  v_due_date date;
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT total_amount, status, due_date
    INTO v_total, v_existing_status, v_due_date
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(sum(amount), 0), max(payment_date),
         COALESCE(sum(rounding_amount), 0),
         COALESCE(bool_or(collection_id IS NOT NULL), false)
    INTO v_paid, v_paid_date, v_rounding, v_has_v5_payment
  FROM public.payments
  WHERE invoice_id = p_invoice_id
    AND reversed_at IS NULL;

  -- Legacy writers stored cash change as a separate expense while keeping the
  -- gross amount in payments. V5 payments already store only the applied
  -- amount, so subtract change only from pre-collection vouchers.
  SELECT COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
    INTO v_legacy_refunded
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND lower(btrim(type_row.name)) = 'tiền thối';

  v_paid := v_paid - v_legacy_refunded;

  SELECT COALESCE(sum(voucher.rounding_amount), 0)
    INTO v_legacy_rounding
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;

  SELECT COALESCE(sum(voucher.total_amount), 0)
    INTO v_settlement_refunded
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND voucher.notes LIKE '[Hoàn trả thanh lý]%';

  v_paid := v_paid - v_settlement_refunded;
  v_rounding := v_rounding + v_legacy_rounding;

  IF v_existing_status = 'CANCELLED' THEN
    UPDATE public.invoices
       SET paid_amount = v_paid
     WHERE id = p_invoice_id;
    RETURN;
  END IF;

  IF v_total > 0 THEN
    IF v_paid >= v_total OR v_paid + v_rounding >= v_total
       OR (
         NOT v_has_v5_payment
         AND v_paid > 0
         AND v_total - v_paid > 0
         AND v_total - v_paid < 10000
       ) THEN
      v_status := 'PAID';
    ELSIF v_paid > 0 AND v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSIF v_total < 0 THEN
    IF v_paid <= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid < 0 AND v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid < 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < current_date THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSE
    v_status := CASE
      WHEN v_paid <> 0 THEN 'PAID'::public.invoice_status
      ELSE 'APPROVED'::public.invoice_status
    END;
    IF v_paid = 0 THEN
      v_paid_date := NULL;
    END IF;
  END IF;

  UPDATE public.invoices
     SET paid_amount = v_paid,
         status = v_status,
         paid_date = v_paid_date,
         updated_at = now()
   WHERE id = p_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_invoice_for_id(uuid) FROM PUBLIC, anon, authenticated;

INSERT INTO app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, reason
)
VALUES (
  'invoice.collection.v5', 'invoice_payment', 'MONEY', 'SHADOW',
  'Atomic multi-tender invoice collection with server-derived allocations'
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
  'invoice.collection.reverse.v5', 'invoice_payment', 'MONEY', 'SHADOW',
  'Compensating reversal route kept independent from forward canary caps'
)
ON CONFLICT (feature_key) DO UPDATE
SET domain = EXCLUDED.domain,
    risk_class = EXCLUDED.risk_class,
    reason = EXCLUDED.reason,
    updated_at = now();

CREATE TABLE IF NOT EXISTS app_private.accounting_chain_writer_xids (
  transaction_id bigint NOT NULL,
  backend_pid integer NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transaction_id, backend_pid)
);

CREATE OR REPLACE FUNCTION app_private.begin_accounting_chain_write_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private
AS $$
BEGIN
  INSERT INTO app_private.accounting_chain_writer_xids (
    transaction_id, backend_pid, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid)
    DO UPDATE SET opened_at = EXCLUDED.opened_at;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.end_accounting_chain_write_v1()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private
AS $$
  DELETE FROM app_private.accounting_chain_writer_xids
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();
$$;

REVOKE ALL ON app_private.accounting_chain_writer_xids
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.begin_accounting_chain_write_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.end_accounting_chain_write_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- Legacy clients may still create ordinary payment/voucher rows during the
-- rollout, but canonical link and accounting fields are core-writer only.
CREATE OR REPLACE FUNCTION app_private.guard_payment_canonical_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private, public
AS $$
DECLARE
  v_id uuid;
  v_core_writer boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  IF v_core_writer THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW.collection_id IS NOT NULL
    OR NEW.tender_id IS NOT NULL
    OR NEW.received_amount IS NOT NULL
    OR COALESCE(NEW.credit_amount, 0) <> 0
    OR COALESCE(NEW.change_amount, 0) <> 0
    OR COALESCE(NEW.rounding_amount, 0) <> 0
    OR NEW.reversed_at IS NOT NULL
    OR NEW.reversed_by_collection_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Canonical payment fields are core-writer only'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
    OR NEW.received_amount IS DISTINCT FROM OLD.received_amount
    OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount
    OR NEW.change_amount IS DISTINCT FROM OLD.change_amount
    OR NEW.rounding_amount IS DISTINCT FROM OLD.rounding_amount
    OR NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
    OR NEW.reversed_by_collection_id IS DISTINCT FROM OLD.reversed_by_collection_id
  ) THEN
    RAISE EXCEPTION 'Canonical payment fields are core-writer only'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.income_expenses voucher
    WHERE voucher.payment_id = v_id
      AND voucher.deleted_at IS NULL
      AND app_private.is_income_expense_flow_owned(voucher.id)
  ) THEN
    RAISE EXCEPTION 'payment % links a canonical voucher - direct % rejected',
      v_id, TG_OP USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a00_payment_canonical_link_guard ON public.payments;
CREATE TRIGGER a00_payment_canonical_link_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_payment_canonical_link();

CREATE OR REPLACE FUNCTION app_private.guard_income_expense_accounting_links_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private, public
AS $$
DECLARE
  v_core_writer boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF v_core_writer THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW.payment_collection_id IS NOT NULL
    OR NEW.reversal_of_income_expense_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Canonical voucher links are core-writer only'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.payment_collection_id IS DISTINCT FROM OLD.payment_collection_id
    OR NEW.reversal_of_income_expense_id IS DISTINCT FROM OLD.reversal_of_income_expense_id
  ) THEN
    RAISE EXCEPTION 'Canonical voucher links are core-writer only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a00_income_expense_accounting_links_guard
  ON public.income_expenses;
CREATE TRIGGER a00_income_expense_accounting_links_guard
BEFORE INSERT OR UPDATE ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION app_private.guard_income_expense_accounting_links_v1();

CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5(
  p_invoice_id uuid,
  p_collection_date date,
  p_tenders jsonb,
  p_overpay_action text,
  p_allow_rounding boolean,
  p_notes text,
  p_receipt_image_url text,
  p_expected_paid_amount numeric,
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
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_collection_id uuid;
  v_tender jsonb;
  v_tender_id uuid;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_item_id uuid;
  v_credit_lot_id uuid;
  v_credit_tender_count integer;
  v_excess_id uuid;
  v_account_id uuid;
  v_change_account_id uuid;
  v_rounding_account_id uuid;
  v_method public.payment_method;
  v_gross numeric;
  v_gross_total numeric := 0;
  v_tm_total numeric := 0;
  v_remaining numeric;
  v_applied_total numeric;
  v_change_total numeric := 0;
  v_credit_total numeric := 0;
  v_rounding_total numeric := 0;
  v_retained_total numeric;
  v_remaining_apply numeric;
  v_change_left numeric;
  v_credit_left numeric;
  v_line_left numeric;
  v_line_change numeric;
  v_line_credit numeric;
  v_line_retained numeric;
  v_line_applied numeric;
  v_line_revenue numeric;
  v_line_internal numeric;
  v_line_deposit numeric;
  v_later_tm_total numeric;
  v_revenue_due numeric;
  v_internal_due numeric := 0;
  v_deposit_due numeric := 0;
  v_revenue_covered numeric := 0;
  v_internal_covered numeric := 0;
  v_deposit_covered numeric := 0;
  v_projected_revenue numeric;
  v_projected_internal numeric;
  v_projected_deposit numeric;
  v_projection_left numeric;
  v_idx integer := 0;
  v_last_tm_idx integer := -1;
  v_last_line_idx integer;
  v_revenue_type_id uuid;
  v_deposit_type_id uuid;
  v_credit_type_id uuid;
  v_response jsonb;
  v_tender_results jsonb := '[]'::jsonb;
  v_creator_name text;
  v_rounding_target_account uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF p_collection_date IS NULL OR jsonb_typeof(p_tenders) <> 'array'
     OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'Ngày thu hoặc danh sách phương thức không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id, v_invoice.user_id
    INTO v_org, v_owner
  FROM public.buildings building_row
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, org_row;
  IF v_org IS NULL OR v_invoice.organization_id <> v_org THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'collection_date', p_collection_date,
    'tenders', p_tenders,
    'overpay_action', upper(COALESCE(p_overpay_action, 'REJECT')),
    'allow_rounding', COALESCE(p_allow_rounding, false),
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.v5', p_invoice_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.v5'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.canonical_write_operations compat_operation
    WHERE compat_operation.organization_id = v_org
      AND compat_operation.operation = 'invoice.collection.compat.v4'
      AND compat_operation.subject_scope = p_invoice_id::text
      AND compat_operation.actor_id = v_actor
      AND compat_operation.idempotency_key = v_key
      AND compat_operation.completed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.income_expenses legacy_voucher
    WHERE legacy_voucher.organization_id = v_org
      AND legacy_voucher.idempotency_key = v_key
      AND legacy_voucher.payment_collection_id IS NULL
      AND legacy_voucher.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'idempotency_key đã hoàn tất ở đường payment tương thích'
      USING ERRCODE = '23505';
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF v_invoice.status NOT IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE') THEN
    RAISE EXCEPTION 'Trạng thái hóa đơn không cho phép thu tiền: %', v_invoice.status
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_paid_amount IS NULL
     OR p_expected_paid_amount = 'NaN'::numeric
     OR abs(COALESCE(v_invoice.paid_amount, 0) - p_expected_paid_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn'
      USING ERRCODE = '40001';
  END IF;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_gross := COALESCE((v_tender->>'gross_amount')::numeric, 0);
    IF v_gross = 'NaN'::numeric
       OR v_gross <= 0 OR round(v_gross, 2) <> v_gross THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ'
        USING ERRCODE = '22023';
    END IF;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    v_account_id := NULLIF(v_tender->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải có sổ quỹ' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
        USING ERRCODE = '42501';
    END IF;
    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi vào một sổ quỹ đã chọn' USING ERRCODE = '42501';
    END IF;

    v_gross_total := v_gross_total + v_gross;
    IF v_method = 'TM' THEN
      v_tm_total := v_tm_total + v_gross;
      v_last_tm_idx := v_idx;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  v_last_line_idx := v_idx - 1;
  v_remaining := GREATEST(v_invoice.total_amount - COALESCE(v_invoice.paid_amount, 0), 0);
  v_applied_total := LEAST(v_gross_total, v_remaining);

  IF v_gross_total > v_remaining THEN
    CASE upper(COALESCE(p_overpay_action, 'REJECT'))
      WHEN 'REFUND' THEN v_change_total := v_gross_total - v_remaining;
      WHEN 'CREDIT' THEN
        IF v_invoice.contract_id IS NULL THEN
          RAISE EXCEPTION 'Không thể giữ credit cho hóa đơn không có hợp đồng'
            USING ERRCODE = '22023';
        END IF;
        v_credit_total := v_gross_total - v_remaining;
      ELSE
        RAISE EXCEPTION 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit'
          USING ERRCODE = '22023';
    END CASE;
    IF v_last_tm_idx < 0 OR v_tm_total < v_gross_total - v_remaining THEN
      RAISE EXCEPTION 'Phần thu dư phải nằm trong dòng tiền mặt TM'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_applied_total <= 0 THEN
    RAISE EXCEPTION 'Hóa đơn không còn số tiền có thể thu' USING ERRCODE = '55000';
  END IF;

  IF COALESCE(p_allow_rounding, false)
     AND v_remaining - v_applied_total > 0
     AND v_remaining - v_applied_total < 10000 THEN
    v_rounding_total := v_remaining - v_applied_total;
  END IF;

  v_retained_total := v_gross_total - v_change_total;

  SELECT COALESCE(sum(item.amount), 0)
    INTO v_deposit_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'DEPOSIT';

  SELECT v_deposit_due + COALESCE(sum((source_row->>'amount')::numeric), 0)
    INTO v_deposit_due
  FROM jsonb_array_elements(COALESCE(v_invoice.previous_debt_sources, '[]'::jsonb)) source_row
  WHERE source_row->>'type' = 'deposit';
  v_deposit_due := COALESCE(v_deposit_due, 0);
  SELECT COALESCE(sum(item.amount), 0)
    INTO v_internal_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'NON_PNL';

  v_internal_due := COALESCE(v_internal_due, 0);
  v_revenue_due := GREATEST(
    v_invoice.total_amount - v_deposit_due - v_internal_due,
    0
  );
  IF v_deposit_due = 'NaN'::numeric
     OR v_internal_due = 'NaN'::numeric
     OR v_invoice.total_amount = 'NaN'::numeric
     OR v_deposit_due + v_internal_due - v_invoice.total_amount >= 0.01 THEN
    RAISE EXCEPTION 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'INTERNAL'), 0)
  INTO v_revenue_covered, v_deposit_covered, v_internal_covered
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  LEFT JOIN public.invoice_payment_collections source_collection
    ON source_collection.id = voucher.payment_collection_id
  LEFT JOIN public.payments source_payment
    ON source_payment.id = voucher.payment_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND (
      voucher.payment_collection_id IS NULL
      OR source_collection.status = 'ACTIVE'
    )
    AND (voucher.payment_id IS NULL OR source_payment.reversed_at IS NULL);

  IF v_revenue_covered - v_revenue_due >= 0.01
     OR v_deposit_covered - v_deposit_due >= 0.01
     OR v_internal_covered - v_internal_due >= 0.01 THEN
    RAISE EXCEPTION 'Bút toán đã ghi vượt semantic của hóa đơn; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;
  IF abs(
    v_revenue_covered + v_deposit_covered + v_internal_covered
    - COALESCE(v_invoice.paid_amount, 0)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu không khớp bút toán semantic; cần đối soát trước'
      USING ERRCODE = '55000';
  END IF;
  v_revenue_covered := GREATEST(LEAST(v_revenue_covered, v_revenue_due), 0);
  v_deposit_covered := GREATEST(LEAST(v_deposit_covered, v_deposit_due), 0);
  v_internal_covered := GREATEST(LEAST(v_internal_covered, v_internal_due), 0);

  v_projection_left := v_applied_total;
  v_projected_revenue := v_revenue_covered + LEAST(
    v_projection_left,
    GREATEST(v_revenue_due - v_revenue_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_revenue - v_revenue_covered);
  v_projected_deposit := v_deposit_covered + LEAST(
    v_projection_left,
    GREATEST(v_deposit_due - v_deposit_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_deposit - v_deposit_covered);
  v_projected_internal := v_internal_covered + LEAST(
    v_projection_left,
    GREATEST(v_internal_due - v_internal_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_internal - v_internal_covered);
  IF abs(v_projection_left) >= 0.01 THEN
    RAISE EXCEPTION 'Không thể phân bổ số thu vào semantic hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  IF v_rounding_total > 0 AND (
    v_deposit_due - v_projected_deposit >= 0.01
    OR v_internal_due - v_projected_internal >= 0.01
  ) THEN
    RAISE EXCEPTION 'Không được làm tròn bỏ qua cọc hoặc khoản NON_PNL còn thiếu'
      USING ERRCODE = '22023';
  END IF;

  SELECT type_row.id INTO v_revenue_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC,
           CASE WHEN lower(btrim(type_row.name)) IN ('thu tiền hoá đơn', 'thu tiền hóa đơn') THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_credit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND lower(btrim(type_row.name)) = 'tiền khách trả thừa'
  LIMIT 1 FOR SHARE;

  IF v_revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu hóa đơn' USING ERRCODE = '55000';
  END IF;
  IF v_deposit_due > 0 AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc' USING ERRCODE = '55000';
  END IF;
  IF v_credit_total > 0 AND v_credit_type_id IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description, is_default, is_deposit
    ) VALUES (
      v_org, v_owner, 'Tiền khách trả thừa', 'income',
      'Khoản khách trả dư giữ lại để cấn kỳ sau; ngoài KQKD', false, false
    ) RETURNING id INTO v_credit_type_id;
  END IF;

  v_creator_name := COALESCE(
    auth.jwt()->'user_metadata'->>'full_name',
    auth.jwt()->'user_metadata'->>'name',
    auth.jwt()->>'email',
    'Người dùng'
  );

  PERFORM app_private.claim_feature_operation_v1(
    'invoice.collection.v5',
    v_org,
    p_invoice_id::text,
    v_actor,
    v_key,
    v_retained_total
  );

  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.invoice_payment_collections (
    organization_id, invoice_id, contract_id, status, collection_date,
    actor_id, idempotency_key, payload_hash, expected_paid_amount,
    gross_amount, retained_amount, applied_amount, change_amount,
    credit_amount, rounding_amount, notes, receipt_image_url
  ) VALUES (
    v_org, p_invoice_id, v_invoice.contract_id, 'ACTIVE', p_collection_date,
    v_actor, v_key, v_hash, p_expected_paid_amount,
    v_gross_total, v_retained_total, v_applied_total, v_change_total,
    v_credit_total, v_rounding_total, NULLIF(btrim(p_notes), ''), p_receipt_image_url
  ) RETURNING id INTO v_collection_id;

  v_remaining_apply := v_applied_total;
  v_change_left := v_change_total;
  v_credit_left := v_credit_total;
  v_idx := 0;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_payment_id := NULL;
    v_voucher_id := NULL;
    v_gross := (v_tender->>'gross_amount')::numeric;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    v_account_id := (v_tender->>'account_id')::uuid;
    v_change_account_id := NULLIF(v_tender->>'change_account_id', '')::uuid;
    v_rounding_account_id := NULLIF(v_tender->>'rounding_account_id', '')::uuid;
    v_line_change := 0;
    v_line_credit := 0;
    v_line_revenue := 0;
    v_line_deposit := 0;
    v_line_internal := 0;

    IF v_method = 'TM' AND (v_change_left > 0 OR v_credit_left > 0) THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_tm_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx
        AND later.value->>'payment_method' = 'TM';

      v_line_change := LEAST(
        v_gross,
        GREATEST(v_change_total - v_later_tm_total, 0)
      );
      v_line_credit := LEAST(
        v_gross - v_line_change,
        GREATEST(v_credit_total - v_later_tm_total, 0)
      );
      v_change_left := v_change_left - v_line_change;
      v_credit_left := v_credit_left - v_line_credit;
    END IF;

    IF v_line_change > 0 THEN
      IF v_change_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ tiền thối' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_change_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ tiền thối phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_change_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền ghi tiền thối vào sổ đã chọn'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_line_retained := v_gross - v_line_change;
    v_line_applied := LEAST(v_line_retained - v_line_credit, v_remaining_apply);
    v_remaining_apply := v_remaining_apply - v_line_applied;

    v_line_left := v_line_applied;
    v_line_revenue := LEAST(
      v_line_left,
      GREATEST(v_revenue_due - v_revenue_covered, 0)
    );
    v_revenue_covered := v_revenue_covered + v_line_revenue;
    v_line_left := v_line_left - v_line_revenue;

    v_line_deposit := LEAST(
      v_line_left,
      GREATEST(v_deposit_due - v_deposit_covered, 0)
    );
    v_deposit_covered := v_deposit_covered + v_line_deposit;
    v_line_left := v_line_left - v_line_deposit;

    v_line_internal := LEAST(
      v_line_left,
      GREATEST(v_internal_due - v_internal_covered, 0)
    );
    v_internal_covered := v_internal_covered + v_line_internal;
    v_line_left := v_line_left - v_line_internal;
    IF abs(v_line_left) >= 0.01 THEN
      RAISE EXCEPTION 'Dòng thanh toán không phân bổ hết vào semantic hóa đơn'
        USING ERRCODE = '55000';
    END IF;

    IF v_idx = v_last_line_idx AND v_rounding_total > 0 THEN
      IF v_rounding_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ làm tròn' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_rounding_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ làm tròn phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_rounding_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền dùng sổ làm tròn đã chọn'
          USING ERRCODE = '42501';
      END IF;
      v_rounding_target_account := v_rounding_account_id;
    END IF;

    INSERT INTO public.invoice_payment_tenders (
      organization_id, collection_id, line_index, payment_method, account_id,
      change_account_id, rounding_account_id, gross_amount, retained_amount,
      applied_amount, change_amount, credit_amount, rounding_amount, receipt_number
    ) VALUES (
      v_org, v_collection_id, v_idx, v_method, v_account_id,
      v_change_account_id, v_rounding_account_id, v_gross, v_line_retained,
      v_line_applied, v_line_change, v_line_credit,
      CASE WHEN v_idx = v_last_line_idx THEN v_rounding_total ELSE 0 END,
      NULLIF(v_tender->>'receipt_number', '')
    ) RETURNING id INTO v_tender_id;

    IF v_line_applied > 0 THEN
      INSERT INTO public.payments (
        organization_id, user_id, invoice_id, receipt_number, amount,
        received_amount, credit_amount, change_amount, rounding_amount,
        payment_method, payment_date, notes, receipt_image_url,
        collection_id, tender_id
      ) VALUES (
        v_org, v_owner, p_invoice_id, NULLIF(v_tender->>'receipt_number', ''),
        v_line_applied, v_line_retained, v_line_credit, v_line_change,
        CASE WHEN v_idx = v_last_line_idx THEN v_rounding_total ELSE 0 END,
        v_method, p_collection_date, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 THEN p_receipt_image_url END,
        v_collection_id, v_tender_id
      ) RETURNING id INTO v_payment_id;
    ELSE
      v_payment_id := NULL;
    END IF;

    IF v_line_retained > 0
       OR v_line_change > 0
       OR (v_idx = v_last_line_idx AND v_rounding_total > 0) THEN
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_id, payment_collection_id, voucher_date,
        payer_name, notes, attachments, total_amount, approval_status,
        approved_by, approved_at, business_result_accounting, creator_name,
        change_amount, change_account_id, rounding_amount, rounding_account_id,
        system_source, idempotency_key
      ) VALUES (
        v_owner, v_org, 'INCOME', 'Thu tiền theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_account_id, p_invoice_id, v_payment_id, v_collection_id, p_collection_date,
        NULL, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 AND p_receipt_image_url IS NOT NULL
          THEN jsonb_build_array(p_receipt_image_url) ELSE '[]'::jsonb END,
        v_line_retained, 'APPROVED', v_actor, clock_timestamp(), NULL,
        v_creator_name, v_line_change, v_change_account_id,
        CASE WHEN v_idx = v_last_line_idx THEN v_rounding_total ELSE 0 END,
        CASE WHEN v_idx = v_last_line_idx THEN v_rounding_account_id END,
        'invoice.collection.v5', v_key || ':tender:' || v_idx
      ) RETURNING id INTO v_voucher_id;

      IF v_line_revenue > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Thanh toán HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_revenue, v_line_revenue, p_collection_date, p_collection_date, 'PNL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'PNL', v_line_revenue
        );
      END IF;

      IF v_line_deposit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_deposit_type_id,
          'Tiền cọc theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_deposit, v_line_deposit, p_collection_date, p_collection_date, 'DEPOSIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'DEPOSIT', v_line_deposit
        );
      END IF;

      IF v_line_internal > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Khoản ngoài KQKD theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_internal, v_line_internal,
          p_collection_date, p_collection_date, 'INTERNAL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'INTERNAL', v_line_internal
        );
      END IF;

      IF v_line_credit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_credit_type_id,
          'Tiền khách trả thừa từ HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_credit, v_line_credit, p_collection_date, p_collection_date,
          'CUSTOMER_CREDIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'CUSTOMER_CREDIT', v_line_credit
        );
      END IF;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_voucher_id, v_org, 'INVOICE_COLLECTION_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, v_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;
    END IF;

    UPDATE public.invoice_payment_tenders
       SET payment_id = v_payment_id, voucher_id = v_voucher_id
     WHERE id = v_tender_id;

    v_tender_results := v_tender_results || jsonb_build_array(jsonb_build_object(
      'tender_id', v_tender_id,
      'payment_id', v_payment_id,
      'voucher_id', v_voucher_id,
      'applied_amount', v_line_applied,
      'revenue_amount', v_line_revenue,
      'internal_amount', v_line_internal,
      'deposit_amount', v_line_deposit,
      'credit_amount', v_line_credit,
      'change_amount', v_line_change
    ));
    v_idx := v_idx + 1;
  END LOOP;

  IF v_remaining_apply <> 0 OR v_change_left <> 0 OR v_credit_left <> 0 THEN
    RAISE EXCEPTION 'Phân bổ collection không cân bằng' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_payment_tenders tender
    LEFT JOIN public.invoice_payment_allocations allocation
      ON allocation.tender_id = tender.id
    WHERE tender.collection_id = v_collection_id
    GROUP BY tender.id, tender.retained_amount
    HAVING abs(
      tender.retained_amount - COALESCE(sum(allocation.amount), 0)
    ) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Tổng allocation không khớp số tiền giữ lại của tender'
      USING ERRCODE = '55000';
  END IF;

  IF v_credit_total > 0 THEN
    SELECT count(*) INTO v_credit_tender_count
    FROM public.invoice_payment_tenders
    WHERE collection_id = v_collection_id AND credit_amount > 0;
    IF v_credit_tender_count = 1 THEN
      SELECT id, payment_id INTO v_tender_id, v_payment_id
      FROM public.invoice_payment_tenders
      WHERE collection_id = v_collection_id AND credit_amount > 0;
    ELSE
      v_tender_id := NULL;
      v_payment_id := NULL;
    END IF;

    INSERT INTO public.customer_credit_lots (
      organization_id, contract_id, source_collection_id, source_tender_id,
      source_payment_id, amount, remaining_amount, status
    ) VALUES (
      v_org, v_invoice.contract_id, v_collection_id, v_tender_id,
      v_payment_id, v_credit_total, v_credit_total, 'ACTIVE'
    ) RETURNING id INTO v_credit_lot_id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, v_invoice.contract_id, v_credit_total,
      'Tiền thừa từ hóa đơn ' || COALESCE(v_invoice.invoice_number, ''),
      p_invoice_id, v_payment_id, v_credit_lot_id
    ) RETURNING id INTO v_excess_id;

    UPDATE public.customer_credit_lots
       SET source_excess_amount_id = v_excess_id
     WHERE id = v_credit_lot_id;
  END IF;

  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  SELECT jsonb_build_object(
    'collection_id', v_collection_id,
    'invoice_id', p_invoice_id,
    'gross_amount', v_gross_total,
    'applied_amount', v_applied_total,
    'change_amount', v_change_total,
    'credit_amount', v_credit_total,
    'rounding_amount', v_rounding_total,
    'credit_lot_id', v_credit_lot_id,
    'tenders', v_tender_results,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'invoice.collection.v5'
     AND subject_scope = p_invoice_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_collection_v5(
  uuid, date, jsonb, text, boolean, text, text, numeric, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_collection_v5(
  uuid, date, jsonb, text, boolean, text, text, numeric, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_invoice_collection_v5(
  p_collection_id uuid,
  p_reversal_date date,
  p_reason text,
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
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_collection public.invoice_payment_collections%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_tender public.invoice_payment_tenders%ROWTYPE;
  v_allocation record;
  v_reversal_voucher_id uuid;
  v_reversal_item_id uuid;
  v_expense_type_id uuid;
  v_credit_lot public.customer_credit_lots%ROWTYPE;
  v_response jsonb;
  v_reversal_vouchers jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_reversal_date IS NULL OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Ngày hoàn tác hoặc lý do 8-1000 ký tự không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_collection
  FROM public.invoice_payment_collections
  WHERE id = p_collection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy collection' USING ERRCODE = '42501';
  END IF;
  IF p_reversal_date < v_collection.collection_date THEN
    RAISE EXCEPTION 'Reversal date cannot be earlier than collection date'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = v_collection.invoice_id
  FOR UPDATE;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL
     OR v_invoice.organization_id <> v_org
     OR v_collection.organization_id <> v_org THEN
    RAISE EXCEPTION 'Collection không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.undo',
    v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền hoàn tác thu tiền' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'collection_id', p_collection_id,
    'reversal_date', p_reversal_date,
    'reason', v_reason
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.reverse.v5',
    p_collection_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.reverse.v5'
    AND operation_row.subject_scope = p_collection_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.reverse.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 chưa bật'
      USING ERRCODE = '55000';
  END IF;

  IF v_collection.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Collection đã được hoàn tác' USING ERRCODE = '23505';
  END IF;

  -- Allocation is revenue-first then deposit. Reversing an older collection
  -- would leave newer allocation rows attached to the wrong accounting class.
  IF abs(
    COALESCE(v_invoice.paid_amount, 0)
    - (v_collection.expected_paid_amount + v_collection.applied_amount)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Phải hoàn tác khoản thu mới hơn trước (thứ tự LIFO)'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_credit_lot
  FROM public.customer_credit_lots lot
  WHERE lot.source_collection_id = p_collection_id
  FOR UPDATE;
  IF FOUND AND v_credit_lot.remaining_amount <> v_credit_lot.amount THEN
    RAISE EXCEPTION 'Credit của collection đã được sử dụng; phải unwind trước khi hoàn tác'
      USING ERRCODE = '55000';
  END IF;

  SELECT type_row.id INTO v_expense_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_collection.organization_id
    AND lower(type_row.type) = 'expense'
    AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
  LIMIT 1 FOR SHARE;
  IF v_expense_type_id IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description, is_default, is_deposit
    ) VALUES (
      v_collection.organization_id, v_invoice.user_id,
      'Hoàn tác thu tiền', 'expense',
      'Bút toán đối ứng cho collection đã hoàn tác', false, false
    ) RETURNING id INTO v_expense_type_id;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();

  FOR v_tender IN
    SELECT * FROM public.invoice_payment_tenders
    WHERE collection_id = p_collection_id
    ORDER BY line_index
    FOR UPDATE
  LOOP
    IF v_tender.voucher_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_collection.organization_id, 'thu_tien.undo',
      v_invoice.building_id, v_tender.account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, invoice_id, payment_collection_id, reversal_of_income_expense_id,
      voucher_date, total_amount, approval_status, approved_by, approved_at,
      notes, business_result_accounting, creator_name, system_source,
      idempotency_key, change_amount, change_account_id,
      rounding_amount, rounding_account_id
    ) VALUES (
      v_invoice.user_id, v_collection.organization_id, 'EXPENSE',
      'Hoàn tác thu tiền ' || COALESCE(v_invoice.invoice_number, ''),
      v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
      v_tender.account_id, NULL, p_collection_id, v_tender.voucher_id,
      p_reversal_date, v_tender.retained_amount, 'APPROVED', v_actor,
      clock_timestamp(), v_reason, NULL, 'Invoice Collection V5',
      'invoice.collection.reverse.v5', v_key || ':tender:' || v_tender.line_index,
      -v_tender.change_amount, v_tender.change_account_id,
      -v_tender.rounding_amount, v_tender.rounding_account_id
    ) RETURNING id INTO v_reversal_voucher_id;

    FOR v_allocation IN
      SELECT allocation.accounting_class, allocation.amount
      FROM public.invoice_payment_allocations allocation
      WHERE allocation.tender_id = v_tender.id
      ORDER BY allocation.id
    LOOP
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id, description,
        quantity, unit_price, amount, start_date, end_date, accounting_class
      ) VALUES (
        v_reversal_voucher_id, v_collection.organization_id, v_expense_type_id,
        CASE v_allocation.accounting_class
          WHEN 'PNL' THEN 'Hoàn tác doanh thu hóa đơn'
          WHEN 'DEPOSIT' THEN 'Hoàn tác tiền cọc'
          WHEN 'CUSTOMER_CREDIT' THEN 'Hoàn tác credit khách hàng'
          ELSE 'Hoàn tác khoản ngoài KQKD'
        END,
        1, v_allocation.amount, v_allocation.amount,
        p_reversal_date, p_reversal_date, v_allocation.accounting_class
      ) RETURNING id INTO v_reversal_item_id;
    END LOOP;

    INSERT INTO app_private.income_expense_flow_ownership (
      income_expense_id, organization_id, flow_kind, flow_version,
      lifecycle_owner, lifecycle_state, writer_operation,
      payload_hash_scheme, payload_hash_value, maker_user_id,
      claimed_by_user_id, correlation_id
    ) VALUES (
      v_reversal_voucher_id, v_collection.organization_id,
      'INVOICE_COLLECTION_REVERSAL_V5', 5,
      'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.reverse.v5',
      'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, p_collection_id
    ) ON CONFLICT (income_expense_id) DO NOTHING;

    IF v_tender.payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET reversed_at = clock_timestamp(),
             reversed_by_collection_id = p_collection_id,
             updated_at = now()
       WHERE id = v_tender.payment_id;

      INSERT INTO app_private.payment_reversals (
        original_payment_id, reversal_voucher_id, organization_id, actor_id, reason
      ) VALUES (
        v_tender.payment_id, v_reversal_voucher_id,
        v_collection.organization_id, v_actor, v_reason
      ) ON CONFLICT (original_payment_id) DO NOTHING;
    END IF;

    v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
      'source_voucher_id', v_tender.voucher_id,
      'reversal_voucher_id', v_reversal_voucher_id,
      'account_id', v_tender.account_id,
      'amount', v_tender.retained_amount
    ));
  END LOOP;

  IF v_credit_lot.id IS NOT NULL THEN
    UPDATE public.customer_credit_lots
       SET remaining_amount = 0, status = 'REVERSED', reversed_at = clock_timestamp()
     WHERE id = v_credit_lot.id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_collection.organization_id, v_invoice.user_id, v_collection.contract_id,
      -v_credit_lot.amount, 'Hoàn tác credit collection',
      v_invoice.id, v_credit_lot.source_payment_id, v_credit_lot.id
    );
  END IF;

  UPDATE public.invoice_payment_collections
     SET status = 'REVERSED', reversed_at = clock_timestamp(), reversed_by = v_actor,
         reversal_date = p_reversal_date, reversal_reason = v_reason,
         reversal_idempotency_key = v_key
   WHERE id = p_collection_id;

  PERFORM public.recompute_invoice_for_id(v_invoice.id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  SELECT jsonb_build_object(
    'collection_id', p_collection_id,
    'status', 'REVERSED',
    'reversal_date', p_reversal_date,
    'reversal_vouchers', v_reversal_vouchers,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice.id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = p_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_collection.organization_id
     AND operation = 'invoice.collection.reverse.v5'
     AND subject_scope = p_collection_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  TO authenticated;

-- Compatibility wrappers: old cached clients retain the signature but all
-- authorization, accounting and idempotency now run through V5.
DO $$
BEGIN
  IF to_regprocedure(
    'public.record_invoice_payment_v2(uuid,numeric,public.payment_method,date,text,text)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.record_invoice_payment_v2(
      uuid, numeric, public.payment_method, date, text, text
    ) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
  IF to_regprocedure(
    'public._record_invoice_payment_v4_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
  ) IS NULL
     AND to_regprocedure(
       'public.record_invoice_payment_v4(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    ALTER FUNCTION public.record_invoice_payment_v4(
      uuid, numeric, public.payment_method, date, text, uuid, text, text,
      jsonb, jsonb, text, uuid
    ) RENAME TO _record_invoice_payment_v4_legacy;
  END IF;

  IF to_regprocedure(
    'public._record_invoice_payment_v3_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
  ) IS NULL
     AND to_regprocedure(
       'public.record_invoice_payment_v3(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
     ) IS NOT NULL THEN
    ALTER FUNCTION public.record_invoice_payment_v3(
      uuid, numeric, public.payment_method, date, text, uuid, text, text,
      jsonb, jsonb, text, uuid
    ) RENAME TO _record_invoice_payment_v3_legacy;
  END IF;

  IF to_regprocedure(
    'public._reverse_invoice_payment_v3_legacy(uuid,text,text)'
  ) IS NULL
     AND to_regprocedure('public.reverse_invoice_payment_v3(uuid,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.reverse_invoice_payment_v3(uuid, text, text)
      RENAME TO _reverse_invoice_payment_v3_legacy;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v4(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method public.payment_method,
  p_payment_date date,
  p_idempotency_key text,
  p_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL,
  p_voucher jsonb DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_receipt_number text DEFAULT NULL,
  p_voucher_owner_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_action text := 'REJECT';
  v_result jsonb;
  v_change numeric := COALESCE((p_voucher->>'change_amount')::numeric, 0);
  v_rounding numeric := COALESCE((p_voucher->>'rounding_amount')::numeric, 0);
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;
  IF p_voucher_owner_id IS NOT NULL AND p_voucher_owner_id <> v_invoice.user_id THEN
    RAISE EXCEPTION 'p_voucher_owner_id không khớp chủ hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL OR v_invoice.organization_id <> v_org THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, p_account_id
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  IF v_change < 0 OR v_rounding < 0
     OR p_amount IS NULL OR p_amount = 'NaN'::numeric OR p_amount <= 0
     OR v_change = 'NaN'::numeric OR v_rounding = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Số tiền hoặc metadata thanh toán không hợp lệ'
      USING ERRCODE = '22023';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'Writer tương thích yêu cầu sổ nhận tiền'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM public.accounts account_row
  WHERE account_row.id = p_account_id
    AND account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
      USING ERRCODE = '42501';
  END IF;
  IF v_change > 0 THEN
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = NULLIF(p_voucher->>'change_account_id', '')::uuid
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ tiền thối phải là sổ ảo của tổ chức'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_rounding > 0 THEN
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = NULLIF(p_voucher->>'rounding_account_id', '')::uuid
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ làm tròn phải là sổ ảo của tổ chức'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_change > 0 THEN
    v_action := 'REFUND';
  ELSIF COALESCE(v_invoice.paid_amount, 0) + p_amount > v_invoice.total_amount THEN
    v_action := 'CREDIT';
  END IF;

  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'amount', p_amount,
    'payment_method', p_payment_method,
    'payment_date', p_payment_date,
    'account_id', p_account_id,
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url,
    'voucher', p_voucher,
    'items', p_items,
    'receipt_number', p_receipt_number,
    'voucher_owner_id', p_voucher_owner_id
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.compat.v4', p_invoice_id::text, v_actor,
    v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.compat.v4'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload::json;
  END IF;

  v_route := app_private.evaluate_feature_route(
    'invoice.collection.v5', v_org
  );
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer thu tiền đang bị đóng băng' USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    IF v_action = 'CREDIT' OR EXISTS (
      SELECT 1
      FROM public.invoice_items item
      WHERE item.invoice_id = p_invoice_id
        AND item.accounting_class <> 'REVENUE'
    ) THEN
      RAISE EXCEPTION 'Writer legacy không bảo toàn semantic cọc/credit/NON_PNL'
        USING ERRCODE = '55000';
    END IF;
    IF p_voucher IS NULL OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'Writer legacy yêu cầu phiếu thu và hạng mục đầy đủ'
        USING ERRCODE = '55000';
    END IF;

    IF to_regprocedure(
      'public._record_invoice_payment_v4_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
    ) IS NOT NULL THEN
      EXECUTE
        'SELECT public._record_invoice_payment_v4_legacy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
        INTO v_result
        USING p_invoice_id, p_amount, p_payment_method, p_payment_date,
              p_idempotency_key, p_account_id, p_notes, p_receipt_image_url,
              p_voucher, p_items, p_receipt_number, p_voucher_owner_id;
    ELSIF to_regprocedure(
      'public._record_invoice_payment_v3_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
    ) IS NOT NULL THEN
      EXECUTE
        'SELECT public._record_invoice_payment_v3_legacy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
        INTO v_result
        USING p_invoice_id, p_amount, p_payment_method, p_payment_date,
              p_idempotency_key, p_account_id, p_notes, p_receipt_image_url,
              p_voucher, p_items, p_receipt_number, p_voucher_owner_id;
    ELSE
      RAISE EXCEPTION 'Legacy payment writer is unavailable during rollout'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    v_result := public.record_invoice_collection_v5(
      p_invoice_id,
      p_payment_date,
      jsonb_build_array(jsonb_build_object(
        'payment_method', p_payment_method,
        'gross_amount', p_amount + v_change,
        'account_id', p_account_id,
        'change_account_id', p_voucher->>'change_account_id',
        'rounding_account_id', p_voucher->>'rounding_account_id',
        'receipt_number', p_receipt_number
      )),
      v_action,
      v_rounding > 0,
      p_notes,
      p_receipt_image_url,
      COALESCE(v_invoice.paid_amount, 0),
      p_idempotency_key
    );
    v_result := jsonb_build_object(
      'payment_id', v_result#>'{tenders,0,payment_id}',
      'voucher_id', v_result#>'{tenders,0,voucher_id}',
      'new_paid_amount', v_result#>'{invoice,paid_amount}',
      'new_status', v_result#>'{invoice,status}',
      'excess_amount', v_result->'credit_amount',
      'collection_id', v_result->'collection_id'
    );
  END IF;

  UPDATE app_private.canonical_write_operations
     SET subject_id = NULLIF(v_result->>'payment_id', '')::uuid,
         response_payload = v_result,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = 'invoice.collection.compat.v4'
     AND subject_scope = p_invoice_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  RETURN v_result::json;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v3(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method public.payment_method,
  p_payment_date date,
  p_idempotency_key text,
  p_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL,
  p_voucher jsonb DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_receipt_number text DEFAULT NULL,
  p_voucher_owner_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.record_invoice_payment_v4(
    p_invoice_id, p_amount, p_payment_method, p_payment_date, p_idempotency_key,
    p_account_id, p_notes, p_receipt_image_url, p_voucher, p_items,
    p_receipt_number, p_voucher_owner_id
  );
$$;

CREATE OR REPLACE FUNCTION public.reverse_invoice_payment_v3(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_collection_id uuid;
  v_org uuid;
  v_payment_date date;
  v_received_amount numeric;
  v_reversal_date date;
  v_tender_count integer;
  v_route text;
  v_result json;
  v_source_count integer;
  v_source_account_count integer;
  v_source_account uuid;
  v_source_voucher uuid;
  v_source_total numeric;
  v_reversal_voucher uuid;
  v_existing_source uuid;
  v_reversal_created_at timestamptz;
  v_reversal_type uuid;
  v_item record;
BEGIN
  SELECT payment.collection_id, building_row.organization_id,
         payment.payment_date, payment.received_amount
    INTO v_collection_id, v_org, v_payment_date, v_received_amount
  FROM public.payments payment
  JOIN public.invoices invoice ON invoice.id = payment.invoice_id
  JOIN public.buildings building_row
    ON building_row.id = invoice.building_id
   AND building_row.deleted_at IS NULL
   AND building_row.organization_id = invoice.organization_id
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE payment.id = p_payment_id
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy payment' USING ERRCODE = '42501';
  END IF;

  IF v_collection_id IS NULL THEN
    PERFORM app_private.lock_org_for_decision_v1(v_org);
    v_route := app_private.evaluate_feature_route('invoice.collection.reverse.v5', v_org);
    IF v_route = 'FROZEN' THEN
      RAISE EXCEPTION 'Writer hoàn tác thu tiền đang bị đóng băng'
        USING ERRCODE = '55000';
    END IF;
    IF to_regprocedure('public._reverse_invoice_payment_v3_legacy(uuid,text,text)') IS NULL THEN
      RAISE EXCEPTION 'Payment legacy chưa có writer hoàn tác tương thích'
        USING ERRCODE = '55000';
    END IF;

    IF v_received_amount IS NULL THEN
      RAISE EXCEPTION 'Payment legacy chưa được chuẩn hoá ngữ nghĩa thu tiền'
        USING ERRCODE = '55000';
    END IF;
    IF v_received_amount = 0 THEN
      RAISE EXCEPTION 'Đây là bút toán cấn trừ thanh lý, không phải khoản thu tiền để hoàn tác riêng'
        USING ERRCODE = '55000';
    END IF;

    WITH source_vouchers AS (
      SELECT voucher.id, voucher.account_id, voucher.created_at, 0 AS source_rank
      FROM public.income_expenses voucher
      WHERE voucher.payment_id = p_payment_id
        AND voucher.organization_id = v_org
        AND voucher.type = 'INCOME'
        AND voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL

      UNION ALL

      SELECT voucher.id, voucher.account_id, voucher.created_at, 1 AS source_rank
      FROM public.income_expenses voucher
      WHERE voucher.payment_id IS NULL
        AND voucher.organization_id = v_org
        AND voucher.type = 'INCOME'
        AND voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL
        AND voucher.notes = '[THU TACH COC ' || p_payment_id::text || ']'

      UNION ALL

      SELECT voucher.id, voucher.account_id, voucher.created_at, 2 AS source_rank
      FROM public.income_expenses voucher
      WHERE p_payment_id = '5b32cb16-b579-4427-bebf-108c5195a279'::uuid
        AND voucher.id = '2ea26ca0-92c6-4896-a7b5-a5ee7031b2cc'::uuid
        AND voucher.organization_id = v_org
        AND voucher.type = 'INCOME'
        AND voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL
    ), distinct_sources AS (
      SELECT DISTINCT ON (source.id)
        source.id, source.account_id, source.created_at, source.source_rank
      FROM source_vouchers source
      ORDER BY source.id, source.source_rank
    )
    SELECT
      count(*)::integer,
      count(DISTINCT source.account_id)::integer,
      (array_agg(source.account_id ORDER BY source.source_rank, source.created_at, source.id))[1],
      (array_agg(source.id ORDER BY source.source_rank, source.created_at, source.id))[1],
      COALESCE(sum(item.amount) FILTER (
        WHERE item.accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT')
      ), 0)
      INTO v_source_count, v_source_account_count, v_source_account,
           v_source_voucher, v_source_total
    FROM distinct_sources source
    LEFT JOIN public.income_expense_items item
      ON item.income_expense_id = source.id;

    IF v_source_count < 1
       OR v_source_account_count <> 1
       OR v_source_account IS NULL
       OR abs(v_source_total - v_received_amount) >= 0.01 THEN
      RAISE EXCEPTION 'Nguồn kế toán payment legacy không đầy đủ hoặc không cân (% / %)',
        v_source_total, v_received_amount USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.accounts account_row
      WHERE account_row.id = v_source_account
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
    ) THEN
      RAISE EXCEPTION 'Sổ nguồn payment legacy không hợp lệ hoặc là sổ ảo'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE 'SELECT public._reverse_invoice_payment_v3_legacy($1,$2,$3)'
      INTO v_result USING p_payment_id, p_reason, p_idempotency_key;

    v_reversal_voucher := NULLIF(v_result->>'reversal_voucher_id', '')::uuid;
    IF v_reversal_voucher IS NULL THEN
      RAISE EXCEPTION 'Writer legacy không trả về reversal_voucher_id'
        USING ERRCODE = '55000';
    END IF;

    SELECT reversal.created_at, voucher.reversal_of_income_expense_id,
           voucher.voucher_date
      INTO v_reversal_created_at, v_existing_source, v_reversal_date
    FROM app_private.payment_reversals reversal
    JOIN public.income_expenses voucher
      ON voucher.id = reversal.reversal_voucher_id
    WHERE reversal.original_payment_id = p_payment_id
      AND reversal.reversal_voucher_id = v_reversal_voucher
    FOR UPDATE OF voucher;

    IF v_reversal_created_at IS NULL THEN
      RAISE EXCEPTION 'Không tìm thấy ledger hoàn tác payment legacy'
        USING ERRCODE = '55000';
    END IF;

    -- A replay keeps the date and classified items committed by the first call.
    IF v_existing_source IS NOT NULL THEN
      IF v_existing_source <> v_source_voucher THEN
        RAISE EXCEPTION 'Nguồn hoàn tác payment legacy đã thay đổi'
          USING ERRCODE = '55000';
      END IF;
      RETURN v_result;
    END IF;

    v_reversal_date := GREATEST(
      v_payment_date,
      public.vn_local_date(v_reversal_created_at)
    );

    PERFORM app_private.begin_accounting_chain_write_v1();

    SELECT type_row.id INTO v_reversal_type
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_org
      AND lower(type_row.type) = 'expense'
      AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
    ORDER BY type_row.created_at, type_row.id
    LIMIT 1;

    IF v_reversal_type IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description,
        is_default, is_deposit
      )
      SELECT
        v_org, invoice.user_id, 'Hoàn tác thu tiền', 'expense',
        'Bút toán đối ứng cho khoản thu đã hoàn tác', false, false
      FROM public.invoices invoice
      JOIN public.payments payment ON payment.invoice_id = invoice.id
      WHERE payment.id = p_payment_id
      RETURNING id INTO v_reversal_type;
    END IF;

    UPDATE public.income_expenses
       SET account_id = v_source_account,
           voucher_date = v_reversal_date,
           reversal_of_income_expense_id = v_source_voucher
     WHERE id = v_reversal_voucher;

    UPDATE public.income_expense_items
       SET accounting_class = 'INTERNAL', unit_price = 0, amount = 0
     WHERE income_expense_id = v_reversal_voucher;

    FOR v_item IN
      WITH source_vouchers AS (
        SELECT voucher.id
        FROM public.income_expenses voucher
        WHERE voucher.payment_id = p_payment_id
          AND voucher.organization_id = v_org
          AND voucher.type = 'INCOME'
          AND voucher.approval_status = 'APPROVED'
          AND voucher.deleted_at IS NULL
        UNION
        SELECT voucher.id
        FROM public.income_expenses voucher
        WHERE voucher.payment_id IS NULL
          AND voucher.organization_id = v_org
          AND voucher.type = 'INCOME'
          AND voucher.approval_status = 'APPROVED'
          AND voucher.deleted_at IS NULL
          AND voucher.notes = '[THU TACH COC ' || p_payment_id::text || ']'
        UNION
        SELECT '2ea26ca0-92c6-4896-a7b5-a5ee7031b2cc'::uuid
        WHERE p_payment_id = '5b32cb16-b579-4427-bebf-108c5195a279'::uuid
      )
      SELECT item.accounting_class, sum(item.amount) AS amount
      FROM source_vouchers source
      JOIN public.income_expense_items item ON item.income_expense_id = source.id
      WHERE item.accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT')
      GROUP BY item.accounting_class
      ORDER BY item.accounting_class
    LOOP
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id,
        description, quantity, unit_price, amount, start_date, end_date,
        accounting_class
      ) VALUES (
        v_reversal_voucher, v_org, v_reversal_type,
        'Hoàn tác payment legacy ' || v_item.accounting_class,
        1, v_item.amount, v_item.amount,
        v_reversal_date, v_reversal_date, v_item.accounting_class
      );
    END LOOP;

    UPDATE public.payments payment
       SET reversed_at = v_reversal_created_at,
           updated_at = now()
     WHERE payment.id = p_payment_id
       AND payment.reversed_at IS NULL;

    PERFORM public.recompute_ie_business_result(v_reversal_voucher);
    PERFORM public.recompute_invoice_for_id((
      SELECT payment.invoice_id FROM public.payments payment
      WHERE payment.id = p_payment_id
    ));
    PERFORM public.recompute_contract_deposit_paid((
      SELECT invoice.contract_id
      FROM public.payments payment
      JOIN public.invoices invoice ON invoice.id = payment.invoice_id
      WHERE payment.id = p_payment_id
    ));
    PERFORM app_private.end_accounting_chain_write_v1();

    RETURN v_result;
  END IF;

  SELECT count(*) INTO v_tender_count
  FROM public.invoice_payment_tenders tender
  WHERE tender.collection_id = v_collection_id;
  IF v_tender_count <> 1 THEN
    RAISE EXCEPTION 'Collection nhiều phương thức phải hoàn tác ở cấp collection'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(
           collection.reversal_date,
           GREATEST(
             collection.collection_date,
             public.vn_local_date(clock_timestamp())
           )
         )
    INTO v_reversal_date
  FROM public.invoice_payment_collections collection
  WHERE collection.id = v_collection_id
  FOR SHARE;
  IF v_reversal_date IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy collection cần hoàn tác'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.reverse_invoice_collection_v5(
    v_collection_id,
    v_reversal_date,
    p_reason,
    p_idempotency_key
  )::json;
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_payment_v4(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v4(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) TO authenticated;

REVOKE ALL ON FUNCTION public.record_invoice_payment_v3(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v3(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) TO authenticated;

REVOKE ALL ON FUNCTION public.reverse_invoice_payment_v3(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_payment_v3(uuid, text, text)
  TO authenticated;

DO $$
BEGIN
  IF to_regprocedure(
    'public._record_invoice_payment_v4_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public._record_invoice_payment_v4_legacy(
      uuid, numeric, public.payment_method, date, text, uuid, text, text,
      jsonb, jsonb, text, uuid
    ) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
  IF to_regprocedure(
    'public._record_invoice_payment_v3_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public._record_invoice_payment_v3_legacy(
      uuid, numeric, public.payment_method, date, text, uuid, text, text,
      jsonb, jsonb, text, uuid
    ) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
  IF to_regprocedure('public._reverse_invoice_payment_v3_legacy(uuid,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public._reverse_invoice_payment_v3_legacy(uuid, text, text)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
