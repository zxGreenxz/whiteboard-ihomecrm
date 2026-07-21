-- Termination-generated payments settle invoice A/R with deposit/internal
-- offsets. They must keep payments.amount for invoice recomputation while
-- reporting zero cash received.

BEGIN;

DO $assert_reversal$
DECLARE
  v_definition text;
BEGIN
  IF to_regprocedure(
    'public.reverse_invoice_payment_v3(uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Missing legacy payment reversal gate for termination offsets';
  END IF;

  SELECT pg_get_functiondef(
    'public.reverse_invoice_payment_v3(uuid,text,text)'::regprocedure
  ) INTO v_definition;

  IF position('IF v_received_amount = 0' IN v_definition) = 0
     OR position('bút toán cấn trừ thanh lý' IN v_definition) = 0 THEN
    RAISE EXCEPTION
      'Legacy reversal must reject non-cash termination A/R offsets with a clear message';
  END IF;
END;
$assert_reversal$;

CREATE TABLE IF NOT EXISTS app_private.termination_forfeit_authorizations (
  revenue_voucher_id uuid PRIMARY KEY
    REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  offset_voucher_id uuid NOT NULL UNIQUE
    REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL
    REFERENCES public.contracts(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL
    REFERENCES public.invoices(id) ON DELETE RESTRICT,
  payment_id uuid UNIQUE
    REFERENCES public.payments(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL
    REFERENCES public.accounts(id) ON DELETE RESTRICT,
  amount numeric(15,2) NOT NULL CHECK (
    amount <> 'NaN'::numeric AND amount > 0
  ),
  voucher_date date NOT NULL,
  authorization_source text NOT NULL CHECK (
    authorization_source IN ('BACKFILL_REVIEWED', 'TERMINATION_WRITER')
  ),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT termination_forfeit_authorizations_contract_uq UNIQUE (contract_id)
);

REVOKE ALL ON app_private.termination_forfeit_authorizations
  FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_termination_forfeit_marker_uq
  ON public.payments(invoice_id, notes)
  WHERE reversed_at IS NULL
    AND notes ~ '^\[CẤN CỌC BỎ CỌC PAYMENT [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]$';

CREATE TABLE IF NOT EXISTS app_private.termination_move_out_writer_context (
  transaction_id bigint NOT NULL,
  backend_pid integer NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  building_id uuid NOT NULL,
  room_id uuid NOT NULL,
  move_out_date date NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transaction_id, backend_pid)
);

REVOKE ALL ON app_private.termination_move_out_writer_context
  FROM PUBLIC, anon, authenticated, service_role;

-- Pending historical pairs are safe to move because neither leg is posted yet.
-- Normalize any old real-account pair onto the canonical internal ledger first.
DO $repair_pending_forfeit_accounts$
DECLARE
  v_row record;
  v_internal_account uuid;
BEGIN
  FOR v_row IN
    SELECT
      revenue.id AS revenue_id,
      offset_voucher.id AS offset_id,
      revenue.organization_id,
      revenue.user_id,
      revenue.account_id AS old_account_id
    FROM public.income_expenses revenue
    JOIN public.income_expenses offset_voucher
      ON offset_voucher.organization_id = revenue.organization_id
     AND offset_voucher.contract_id = revenue.contract_id
     AND offset_voucher.system_source = 'termination.forfeit_offset'
     AND offset_voucher.type = 'EXPENSE'
     AND offset_voucher.approval_status = 'UNAPPROVED'
     AND offset_voucher.deleted_at IS NULL
     AND offset_voucher.account_id = revenue.account_id
     AND offset_voucher.voucher_date = revenue.voucher_date
     AND offset_voucher.total_amount = revenue.total_amount
    JOIN public.accounts account_row ON account_row.id = revenue.account_id
    WHERE revenue.system_source = 'termination.forfeit_revenue'
      AND revenue.type = 'INCOME'
      AND revenue.approval_status = 'UNAPPROVED'
      AND revenue.deleted_at IS NULL
      AND NOT account_row.is_virtual
  LOOP
    v_internal_account := public._internal_settlement_account(v_row.user_id);
    IF NOT EXISTS (
      SELECT 1
      FROM public.accounts account_row
      WHERE account_row.id = v_internal_account
        AND account_row.organization_id = v_row.organization_id
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
    ) THEN
      RAISE EXCEPTION 'Cannot resolve canonical internal account for pending forfeit';
    END IF;

    UPDATE public.income_expenses
       SET account_id = v_internal_account,
           updated_at = now()
     WHERE id IN (v_row.revenue_id, v_row.offset_id);

    INSERT INTO public.accounting_repair_audit (
      organization_id, entity_type, entity_id, repair_code,
      before_snapshot, after_snapshot, details
    ) VALUES
      (
        v_row.organization_id, 'INCOME_EXPENSE', v_row.revenue_id,
        'FORFEIT_PENDING_INTERNAL_ACCOUNT_REPAIR',
        jsonb_build_object('account_id', v_row.old_account_id),
        jsonb_build_object('account_id', v_internal_account),
        jsonb_build_object('paired_voucher_id', v_row.offset_id)
      ),
      (
        v_row.organization_id, 'INCOME_EXPENSE', v_row.offset_id,
        'FORFEIT_PENDING_INTERNAL_ACCOUNT_REPAIR',
        jsonb_build_object('account_id', v_row.old_account_id),
        jsonb_build_object('account_id', v_internal_account),
        jsonb_build_object('paired_voucher_id', v_row.revenue_id)
      )
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$repair_pending_forfeit_accounts$;

CREATE TEMP TABLE _termination_forfeit_authorizations ON COMMIT DROP AS
SELECT
  revenue.id AS revenue_voucher_id,
  offset_voucher.id AS offset_voucher_id,
  revenue.organization_id,
  revenue.contract_id,
  revenue.invoice_id,
  revenue.account_id,
  revenue.total_amount AS amount,
  revenue.voucher_date
FROM public.income_expenses revenue
JOIN public.income_expenses offset_voucher
  ON offset_voucher.organization_id = revenue.organization_id
 AND offset_voucher.contract_id = revenue.contract_id
 AND offset_voucher.system_source = 'termination.forfeit_offset'
 AND offset_voucher.type = 'EXPENSE'
 AND offset_voucher.invoice_id IS NULL
 AND offset_voucher.account_id = revenue.account_id
 AND offset_voucher.voucher_date = revenue.voucher_date
 AND offset_voucher.total_amount = revenue.total_amount
 AND offset_voucher.approval_status = revenue.approval_status
 AND offset_voucher.deleted_at IS NULL
JOIN public.invoices invoice
  ON invoice.id = revenue.invoice_id
 AND invoice.organization_id = revenue.organization_id
 AND invoice.contract_id = revenue.contract_id
 AND invoice.kind = 'SETTLEMENT'
 AND invoice.total_amount = revenue.total_amount
JOIN public.accounts account_row
  ON account_row.id = revenue.account_id
 AND account_row.organization_id = revenue.organization_id
 AND account_row.deleted_at IS NULL
 AND account_row.is_virtual
JOIN LATERAL (
  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
      AS item_total,
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
      WHERE item.accounting_class = 'PNL'
    ), 0) AS pnl_total
  FROM public.income_expense_items item
  WHERE item.income_expense_id = revenue.id
) revenue_items ON true
JOIN LATERAL (
  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
      AS item_total,
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
      WHERE item.accounting_class = 'DEPOSIT'
    ), 0) AS deposit_total
  FROM public.income_expense_items item
  WHERE item.income_expense_id = offset_voucher.id
) offset_items ON true
WHERE revenue.system_source = 'termination.forfeit_revenue'
  AND revenue.type = 'INCOME'
  AND revenue.invoice_id IS NOT NULL
  AND revenue.approval_status IN ('UNAPPROVED', 'APPROVED', 'CANCELLED')
  AND revenue.deleted_at IS NULL
  AND (
    revenue.approval_status = 'CANCELLED'
    OR invoice.deleted_at IS NULL
  )
  AND revenue_items.item_total = revenue.total_amount
  AND revenue_items.pnl_total = revenue.total_amount
  AND offset_items.item_total = offset_voucher.total_amount
  AND offset_items.deposit_total = offset_voucher.total_amount;

ALTER TABLE _termination_forfeit_authorizations
  ADD PRIMARY KEY (revenue_voucher_id),
  ADD UNIQUE (offset_voucher_id),
  ADD UNIQUE (contract_id);

DO $assert_forfeit_backfill$
DECLARE
  v_revenue_count integer;
  v_offset_count integer;
  v_pair_count integer;
BEGIN
  SELECT count(*) INTO v_revenue_count
  FROM public.income_expenses voucher
  WHERE voucher.system_source = 'termination.forfeit_revenue'
    AND voucher.deleted_at IS NULL;

  SELECT count(*) INTO v_offset_count
  FROM public.income_expenses voucher
  WHERE voucher.system_source = 'termination.forfeit_offset'
    AND voucher.deleted_at IS NULL;

  SELECT count(*) INTO v_pair_count
  FROM _termination_forfeit_authorizations;

  IF v_revenue_count <> v_pair_count OR v_offset_count <> v_pair_count THEN
    RAISE EXCEPTION
      'Forfeit provenance backfill is ambiguous: revenue %, offset %, pairs %',
      v_revenue_count, v_offset_count, v_pair_count;
  END IF;
END;
$assert_forfeit_backfill$;

INSERT INTO app_private.termination_forfeit_authorizations (
  revenue_voucher_id, offset_voucher_id, organization_id, contract_id,
  invoice_id, account_id, amount, voucher_date, authorization_source
)
SELECT
  revenue_voucher_id, offset_voucher_id, organization_id, contract_id,
  invoice_id, account_id, amount, voucher_date, 'BACKFILL_REVIEWED'
FROM _termination_forfeit_authorizations
ON CONFLICT (revenue_voucher_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.guard_termination_forfeit_voucher_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_protected boolean;
  v_writer boolean;
  v_status_only boolean;
  v_transition_authorized boolean;
BEGIN
  v_protected := COALESCE(NEW.system_source, '') IN (
    'termination.forfeit_revenue', 'termination.forfeit_offset'
  ) OR (
    TG_OP = 'UPDATE'
    AND COALESCE(OLD.system_source, '') IN (
      'termination.forfeit_revenue', 'termination.forfeit_offset'
    )
  );
  IF NOT v_protected THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.approval_status = 'CANCELLED'
     AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'Cancelled forfeit vouchers are terminal'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_writer;
  IF NOT v_writer THEN
    RAISE EXCEPTION 'Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh lý'
      USING ERRCODE = '55000';
  END IF;

  v_status_only := TG_OP = 'UPDATE'
    AND (
      to_jsonb(NEW) - ARRAY[
        'approval_status', 'approved_by', 'approved_at', 'updated_at'
      ]::text[]
    ) IS NOT DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'approval_status', 'approved_by', 'approved_at', 'updated_at'
      ]::text[]
    );

  IF v_status_only THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_private.ie_transition_authorization transition_row
      WHERE transition_row.income_expense_id = NEW.id
        AND transition_row.xid = pg_current_xact_id()
        AND transition_row.purpose = NEW.approval_status
    ) INTO v_transition_authorized;
    IF NOT v_transition_authorized THEN
      RAISE EXCEPTION 'Forfeit voucher status must be changed by its authorized transition RPC'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a05_termination_forfeit_voucher_guard
  ON public.income_expenses;
CREATE TRIGGER a05_termination_forfeit_voucher_guard
BEFORE INSERT OR UPDATE ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION app_private.guard_termination_forfeit_voucher_v1();

CREATE OR REPLACE FUNCTION app_private.guard_termination_forfeit_item_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_writer boolean;
  v_protected boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.income_expenses voucher
    WHERE voucher.id IN (
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
    )
      AND voucher.system_source IN (
        'termination.forfeit_revenue', 'termination.forfeit_offset'
      )
  ) INTO v_protected;
  IF NOT v_protected THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_writer;
  IF NOT v_writer THEN
    RAISE EXCEPTION 'Hạng mục bỏ cọc chỉ được sửa bởi writer thanh lý'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS a05_termination_forfeit_item_guard
  ON public.income_expense_items;
CREATE TRIGGER a05_termination_forfeit_item_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_termination_forfeit_item_v1();

CREATE OR REPLACE FUNCTION app_private.register_termination_forfeit_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_offset_id uuid;
  v_offset_count integer;
  v_writer boolean;
BEGIN
  IF NEW.system_source IS DISTINCT FROM 'termination.forfeit_revenue' THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_writer;
  IF NOT v_writer THEN
    RAISE EXCEPTION 'Forfeit authorization requires the trusted termination writer'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.type <> 'INCOME'
     OR NEW.approval_status <> 'UNAPPROVED'
     OR NEW.invoice_id IS NULL
     OR NEW.contract_id IS NULL
     OR NEW.account_id IS NULL
     OR NEW.building_id IS NULL
     OR NEW.room_id IS NULL
     OR NEW.total_amount <= 0
     OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Hình dạng phiếu doanh thu bỏ cọc không hợp lệ'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*), (array_agg(offset_voucher.id ORDER BY offset_voucher.id))[1]
    INTO v_offset_count, v_offset_id
  FROM public.income_expenses offset_voucher
  WHERE offset_voucher.organization_id = NEW.organization_id
    AND offset_voucher.user_id = NEW.user_id
    AND offset_voucher.contract_id = NEW.contract_id
    AND offset_voucher.building_id = NEW.building_id
    AND offset_voucher.room_id = NEW.room_id
    AND offset_voucher.system_source = 'termination.forfeit_offset'
    AND offset_voucher.type = 'EXPENSE'
    AND offset_voucher.invoice_id IS NULL
    AND offset_voucher.account_id = NEW.account_id
    AND offset_voucher.voucher_date = NEW.voucher_date
    AND offset_voucher.total_amount = NEW.total_amount
    AND offset_voucher.approval_status = 'UNAPPROVED'
    AND offset_voucher.deleted_at IS NULL;
  IF v_offset_count <> 1 THEN
    RAISE EXCEPTION 'Không xác định duy nhất phiếu đối ứng bỏ cọc'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.invoices invoice
    JOIN public.contracts contract_row
      ON contract_row.id = NEW.contract_id
     AND contract_row.organization_id = NEW.organization_id
     AND contract_row.user_id = NEW.user_id
     AND contract_row.room_id = NEW.room_id
     AND contract_row.deleted_at IS NULL
    JOIN public.rooms room_row
      ON room_row.id = NEW.room_id
     AND room_row.building_id = NEW.building_id
     AND room_row.deleted_at IS NULL
    JOIN public.accounts account_row ON account_row.id = NEW.account_id
    WHERE invoice.id = NEW.invoice_id
      AND invoice.organization_id = NEW.organization_id
      AND invoice.user_id = NEW.user_id
      AND invoice.contract_id = NEW.contract_id
      AND invoice.building_id = NEW.building_id
      AND invoice.room_id = NEW.room_id
      AND invoice.kind = 'SETTLEMENT'
      AND invoice.deleted_at IS NULL
      AND invoice.total_amount = NEW.total_amount
      AND account_row.organization_id = NEW.organization_id
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Invoice hoặc sổ nội bộ của bỏ cọc không hợp lệ'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.termination_forfeit_authorizations (
    revenue_voucher_id, offset_voucher_id, organization_id, contract_id,
    invoice_id, account_id, amount, voucher_date, authorization_source
  ) VALUES (
    NEW.id, v_offset_id, NEW.organization_id, NEW.contract_id,
    NEW.invoice_id, NEW.account_id, NEW.total_amount, NEW.voucher_date,
    'TERMINATION_WRITER'
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS a05_register_termination_forfeit
  ON public.income_expenses;
CREATE TRIGGER a05_register_termination_forfeit
AFTER INSERT ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION app_private.register_termination_forfeit_v1();

REVOKE ALL ON FUNCTION app_private.guard_termination_forfeit_voucher_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_termination_forfeit_item_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.register_termination_forfeit_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.require_termination_forfeit_authorization_v1(
  p_voucher_id uuid,
  p_require_approved boolean,
  p_allow_frozen_cancelled boolean
)
RETURNS app_private.termination_forfeit_authorizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_authorization app_private.termination_forfeit_authorizations%ROWTYPE;
BEGIN
  SELECT auth_row.*
    INTO v_authorization
  FROM app_private.termination_forfeit_authorizations auth_row
  WHERE auth_row.revenue_voucher_id = p_voucher_id
     OR auth_row.offset_voucher_id = p_voucher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missing immutable authorization for termination forfeit voucher'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.income_expenses revenue
    JOIN public.income_expenses offset_voucher
      ON offset_voucher.id = v_authorization.offset_voucher_id
    JOIN public.invoices invoice
      ON invoice.id = v_authorization.invoice_id
    JOIN public.contracts contract_row
      ON contract_row.id = v_authorization.contract_id
    JOIN public.rooms room_row
      ON room_row.id = contract_row.room_id
    JOIN public.accounts account_row
      ON account_row.id = v_authorization.account_id
    JOIN LATERAL (
      SELECT
        count(*)::integer AS item_count,
        count(*) FILTER (
          WHERE item.accounting_class IS DISTINCT FROM 'PNL'
             OR item.organization_id IS DISTINCT FROM v_authorization.organization_id
        )::integer AS invalid_count,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
          AS item_total
      FROM public.income_expense_items item
      WHERE item.income_expense_id = revenue.id
    ) revenue_items ON true
    JOIN LATERAL (
      SELECT
        count(*)::integer AS item_count,
        count(*) FILTER (
          WHERE item.accounting_class IS DISTINCT FROM 'DEPOSIT'
             OR item.organization_id IS DISTINCT FROM v_authorization.organization_id
        )::integer AS invalid_count,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
          AS item_total
      FROM public.income_expense_items item
      WHERE item.income_expense_id = offset_voucher.id
    ) offset_items ON true
    WHERE revenue.id = v_authorization.revenue_voucher_id
      AND revenue.organization_id = v_authorization.organization_id
      AND revenue.user_id = contract_row.user_id
      AND revenue.type = 'INCOME'
      AND revenue.system_source = 'termination.forfeit_revenue'
      AND revenue.contract_id = v_authorization.contract_id
      AND revenue.building_id = room_row.building_id
      AND revenue.room_id = contract_row.room_id
      AND revenue.invoice_id = v_authorization.invoice_id
      AND revenue.account_id = v_authorization.account_id
      AND revenue.total_amount = v_authorization.amount
      AND revenue.voucher_date = v_authorization.voucher_date
      AND revenue.payment_id IS NULL
      AND revenue.payment_collection_id IS NULL
      AND revenue.reversal_of_income_expense_id IS NULL
      AND COALESCE(revenue.change_amount, 0) = 0
      AND revenue.change_account_id IS NULL
      AND COALESCE(revenue.rounding_amount, 0) = 0
      AND revenue.rounding_account_id IS NULL
      AND revenue.deleted_at IS NULL
      AND revenue.approval_status IN ('UNAPPROVED', 'APPROVED', 'CANCELLED')
      AND offset_voucher.organization_id = v_authorization.organization_id
      AND offset_voucher.user_id = contract_row.user_id
      AND offset_voucher.type = 'EXPENSE'
      AND offset_voucher.system_source = 'termination.forfeit_offset'
      AND offset_voucher.contract_id = v_authorization.contract_id
      AND offset_voucher.building_id = room_row.building_id
      AND offset_voucher.room_id = contract_row.room_id
      AND offset_voucher.invoice_id IS NULL
      AND offset_voucher.account_id = v_authorization.account_id
      AND offset_voucher.total_amount = v_authorization.amount
      AND offset_voucher.voucher_date = v_authorization.voucher_date
      AND offset_voucher.payment_id IS NULL
      AND offset_voucher.payment_collection_id IS NULL
      AND offset_voucher.reversal_of_income_expense_id IS NULL
      AND COALESCE(offset_voucher.change_amount, 0) = 0
      AND offset_voucher.change_account_id IS NULL
      AND COALESCE(offset_voucher.rounding_amount, 0) = 0
      AND offset_voucher.rounding_account_id IS NULL
      AND offset_voucher.deleted_at IS NULL
      AND offset_voucher.approval_status IN ('UNAPPROVED', 'APPROVED', 'CANCELLED')
      AND invoice.organization_id = v_authorization.organization_id
      AND invoice.user_id = contract_row.user_id
      AND invoice.contract_id = v_authorization.contract_id
      AND invoice.building_id = room_row.building_id
      AND invoice.room_id = contract_row.room_id
      AND invoice.kind = 'SETTLEMENT'
      AND invoice.total_amount = v_authorization.amount
      AND (
        invoice.deleted_at IS NULL
        OR (
          p_allow_frozen_cancelled
          AND revenue.approval_status = 'CANCELLED'
          AND offset_voucher.approval_status = 'CANCELLED'
        )
      )
      AND contract_row.organization_id = v_authorization.organization_id
      AND (
        contract_row.deleted_at IS NULL
        OR (
          p_allow_frozen_cancelled
          AND revenue.approval_status = 'CANCELLED'
          AND offset_voucher.approval_status = 'CANCELLED'
        )
      )
      AND (
        room_row.deleted_at IS NULL
        OR (
          p_allow_frozen_cancelled
          AND revenue.approval_status = 'CANCELLED'
          AND offset_voucher.approval_status = 'CANCELLED'
        )
      )
      AND account_row.organization_id = v_authorization.organization_id
      AND (
        account_row.deleted_at IS NULL
        OR (
          p_allow_frozen_cancelled
          AND revenue.approval_status = 'CANCELLED'
          AND offset_voucher.approval_status = 'CANCELLED'
        )
      )
      AND account_row.is_virtual
      AND revenue_items.item_count > 0
      AND revenue_items.invalid_count = 0
      AND revenue_items.item_total = v_authorization.amount
      AND offset_items.item_count > 0
      AND offset_items.invalid_count = 0
      AND offset_items.item_total = v_authorization.amount
      AND COALESCE(revenue.kqkd_amount, 0) = v_authorization.amount
      AND COALESCE(offset_voucher.kqkd_amount, 0) = 0
      AND (
        NOT p_require_approved
        OR (
          revenue.approval_status = 'APPROVED'
          AND offset_voucher.approval_status = 'APPROVED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Termination forfeit authorization no longer matches its exact accounting pair'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_authorization;
END;
$$;

REVOKE ALL ON FUNCTION app_private.require_termination_forfeit_authorization_v1(
  uuid, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;

DO $validate_forfeit_backfill$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT auth_row.revenue_voucher_id
    FROM app_private.termination_forfeit_authorizations auth_row
    WHERE auth_row.authorization_source = 'BACKFILL_REVIEWED'
    ORDER BY auth_row.revenue_voucher_id
  LOOP
    BEGIN
      PERFORM app_private.require_termination_forfeit_authorization_v1(
        v_row.revenue_voucher_id, false, true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Backfilled forfeit authorization % failed validation: %',
        v_row.revenue_voucher_id, SQLERRM;
    END;
  END LOOP;
END
$validate_forfeit_backfill$;

CREATE OR REPLACE FUNCTION app_private.classify_termination_payment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_core_writer boolean;
  v_invoice_org uuid;
  v_forfeit_voucher_id uuid;
  v_forfeit_authorization app_private.termination_forfeit_authorizations%ROWTYPE;
  v_is_move_out boolean;
  v_is_forfeit boolean;
BEGIN
  v_is_move_out := COALESCE(NEW.notes, '') ~
    '^Quyết toán khi thanh lý [0-9]{2}/[0-9]{2}/[0-9]{4}( \(cấn cọc\))?$';

  IF COALESCE(NEW.notes, '') ~
     '^\[CẤN CỌC BỎ CỌC PAYMENT [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]$' THEN
    v_forfeit_voucher_id := substring(
      NEW.notes FROM
      '^\[CẤN CỌC BỎ CỌC PAYMENT ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]$'
    )::uuid;
  END IF;
  v_is_forfeit := v_forfeit_voucher_id IS NOT NULL;

  IF NOT v_is_move_out AND NOT v_is_forfeit THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    RAISE EXCEPTION
      'Payment cấn trừ thanh lý phải được tạo bởi writer thanh lý hợp lệ'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.collection_id IS NOT NULL OR NEW.tender_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Payment cấn trừ thanh lý không được gắn collection thu tiền'
      USING ERRCODE = '55000';
  END IF;

  SELECT invoice.organization_id
    INTO v_invoice_org
  FROM public.invoices invoice
  WHERE invoice.id = NEW.invoice_id
    AND invoice.deleted_at IS NULL;

  IF v_invoice_org IS NULL THEN
    RAISE EXCEPTION 'Không xác định được organization của payment thanh lý'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_invoice_org;
  ELSIF NEW.organization_id <> v_invoice_org THEN
    RAISE EXCEPTION 'Payment thanh lý lệch organization với hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  IF v_is_move_out AND (
    NEW.payment_method IS DISTINCT FROM 'CT'::public.payment_method
    OR COALESCE(NEW.amount, 0) <= 0
    OR NOT EXISTS (
      SELECT 1
      FROM app_private.termination_move_out_writer_context context_row
      JOIN public.invoices invoice
        ON invoice.id = NEW.invoice_id
       AND invoice.organization_id = context_row.organization_id
       AND invoice.user_id = context_row.user_id
       AND invoice.contract_id = context_row.contract_id
       AND invoice.building_id = context_row.building_id
       AND invoice.room_id = context_row.room_id
       AND invoice.deleted_at IS NULL
      JOIN public.contracts contract_row
        ON contract_row.id = context_row.contract_id
       AND contract_row.organization_id = context_row.organization_id
       AND contract_row.user_id = context_row.user_id
       AND contract_row.room_id = context_row.room_id
       AND contract_row.deleted_at IS NULL
      JOIN public.rooms room_row
        ON room_row.id = context_row.room_id
       AND room_row.building_id = context_row.building_id
       AND room_row.deleted_at IS NULL
      WHERE context_row.transaction_id = txid_current()
        AND context_row.backend_pid = pg_backend_pid()
        AND NEW.organization_id = context_row.organization_id
        AND NEW.user_id = context_row.user_id
        AND NEW.payment_date = context_row.move_out_date
        AND NEW.amount <= GREATEST(
          COALESCE(invoice.total_amount, 0) - COALESCE(invoice.paid_amount, 0),
          0
        )
    )
  ) THEN
    RAISE EXCEPTION 'Payment move-out does not match the active termination context'
      USING ERRCODE = '55000';
  END IF;

  IF v_is_forfeit AND NOT EXISTS (
    SELECT 1
    FROM public.income_expenses voucher
    WHERE voucher.id = v_forfeit_voucher_id
      AND voucher.organization_id = v_invoice_org
      AND voucher.invoice_id = NEW.invoice_id
      AND voucher.type = 'INCOME'
      AND voucher.system_source = 'termination.forfeit_revenue'
      AND voucher.deleted_at IS NULL
      AND voucher.total_amount = NEW.amount
  ) THEN
    RAISE EXCEPTION 'Không xác minh được phiếu cấn cọc bỏ cọc của payment'
      USING ERRCODE = '55000';
  END IF;

  IF v_is_forfeit THEN
    SELECT validated.*
      INTO v_forfeit_authorization
    FROM app_private.require_termination_forfeit_authorization_v1(
      v_forfeit_voucher_id, true, false
    ) validated;

    IF NEW.organization_id IS DISTINCT FROM v_forfeit_authorization.organization_id
       OR NEW.invoice_id IS DISTINCT FROM v_forfeit_authorization.invoice_id
       OR NEW.amount IS DISTINCT FROM v_forfeit_authorization.amount
       OR NEW.payment_date IS DISTINCT FROM v_forfeit_authorization.voucher_date
       OR NEW.payment_method IS DISTINCT FROM 'CT'::public.payment_method
       OR NOT EXISTS (
         SELECT 1
         FROM public.income_expenses revenue
         JOIN public.contracts contract_row
           ON contract_row.id = v_forfeit_authorization.contract_id
         WHERE revenue.id = v_forfeit_authorization.revenue_voucher_id
           AND NEW.user_id = revenue.user_id
           AND revenue.user_id = contract_row.user_id
       ) THEN
      RAISE EXCEPTION 'Payment does not match the exact authorized forfeit settlement'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.received_amount := 0;
  NEW.credit_amount := 0;
  NEW.change_amount := 0;
  NEW.rounding_amount := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a10_payment_termination_non_cash
  ON public.payments;
CREATE TRIGGER a10_payment_termination_non_cash
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION app_private.classify_termination_payment_v1();

CREATE OR REPLACE FUNCTION app_private.guard_termination_non_cash_payment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_protected boolean;
  v_writer boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM app_private.termination_forfeit_authorizations auth_row
    WHERE auth_row.payment_id = OLD.id
  ) OR (
    OLD.received_amount = 0
    AND (
      COALESCE(OLD.notes, '') ~
        '^Quyết toán khi thanh lý [0-9]{2}/[0-9]{2}/[0-9]{4}( \(cấn cọc\))?$'
      OR COALESCE(OLD.notes, '') ~
        '^\[CẤN CỌC BỎ CỌC PAYMENT [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]$'
    )
  ) INTO v_protected;

  IF NOT v_protected THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_writer;
  IF NOT v_writer THEN
    RAISE EXCEPTION 'Termination non-cash payment is immutable outside its trusted writer'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS a05_termination_non_cash_payment_guard
  ON public.payments;
CREATE TRIGGER a05_termination_non_cash_payment_guard
BEFORE UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_termination_non_cash_payment_v1();

REVOKE ALL ON FUNCTION app_private.classify_termination_payment_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_termination_non_cash_payment_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.classify_termination_payment_v1() IS
  'Classifies contract-termination A/R offsets as non-cash while preserving payments.amount for debt settlement.';

CREATE OR REPLACE FUNCTION app_private.require_termination_forfeit_payment_v1(
  p_revenue_voucher_id uuid
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
BEGIN
  SELECT payment.*
    INTO v_payment
  FROM app_private.termination_forfeit_authorizations auth_row
  JOIN public.income_expenses revenue
    ON revenue.id = auth_row.revenue_voucher_id
  JOIN public.payments payment
    ON payment.id = auth_row.payment_id
  WHERE auth_row.revenue_voucher_id = p_revenue_voucher_id
    AND payment.organization_id = auth_row.organization_id
    AND payment.user_id = revenue.user_id
    AND payment.invoice_id = auth_row.invoice_id
    AND payment.amount = auth_row.amount
    AND payment.payment_method = 'CT'::public.payment_method
    AND payment.payment_date = auth_row.voucher_date
    AND payment.notes = '[CẤN CỌC BỎ CỌC PAYMENT '
      || auth_row.revenue_voucher_id::text || ']'
    AND payment.received_amount = 0
    AND payment.credit_amount = 0
    AND payment.change_amount = 0
    AND payment.rounding_amount = 0
    AND payment.collection_id IS NULL
    AND payment.tender_id IS NULL
    AND payment.reversed_at IS NULL
    AND payment.reversed_by_collection_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.payment_reversals reversal
      WHERE reversal.original_payment_id = payment.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.payments other_payment
      WHERE other_payment.invoice_id = auth_row.invoice_id
        AND other_payment.id <> payment.id
        AND other_payment.reversed_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.payment_reversals other_reversal
          WHERE other_reversal.original_payment_id = other_payment.id
        )
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authorized forfeit payment is missing, duplicated, or has drifted'
      USING ERRCODE = '55000';
  END IF;
  RETURN v_payment;
END;
$$;

REVOKE ALL ON FUNCTION app_private.require_termination_forfeit_payment_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The forfeit implementation creates protected vouchers. Keep the private
-- writer capability scoped to that implementation and always close it again.
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
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
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
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  BEGIN
    v_result := public.terminate_contract_forfeit_impl(
      p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)
  TO authenticated, service_role;

-- The cached move-out RPC predates canonical payment fields. Open the private
-- writer capability only around the trusted implementation so its payment rows
-- can be classified, then close it before returning to the caller.
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
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
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
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_owner,
    p_contract_id, v_building, v_room, p_move_out_date, clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      contract_id = EXCLUDED.contract_id,
      building_id = EXCLUDED.building_id,
      room_id = EXCLUDED.room_id,
      move_out_date = EXCLUDED.move_out_date,
      opened_at = EXCLUDED.opened_at;

  BEGIN
    v_result := public.terminate_contract_move_out_impl(
      p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
      COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
      COALESCE(p_outstanding_debt, 0), p_notes,
      COALESCE(p_extra_charges, '[]'::jsonb),
      COALESCE(p_shortfall_mode, 'PAID'), v_receipt_account
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.termination_move_out_writer_context
    WHERE transaction_id = txid_current()
      AND backend_pid = pg_backend_pid();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(
  uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid
) TO authenticated, service_role;

-- Forfeit settlement creates its A/R offset when the internal revenue voucher
-- is approved, often in a later transaction than terminate_contract_forfeit.
CREATE OR REPLACE FUNCTION public.trg_forfeit_settle_on_approve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_pay_note text;
  v_payment_id uuid;
  v_existing_count integer;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_authorization app_private.termination_forfeit_authorizations%ROWTYPE;
BEGIN
  SELECT auth_row.*
    INTO v_authorization
  FROM app_private.termination_forfeit_authorizations auth_row
  WHERE auth_row.revenue_voucher_id = NEW.id
     OR auth_row.offset_voucher_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT validated.*
    INTO v_authorization
  FROM app_private.require_termination_forfeit_authorization_v1(
    NEW.id, false, false
  ) validated;

  IF NEW.approval_status = 'APPROVED'
     AND COALESCE(OLD.approval_status, '') <> 'APPROVED'
     AND NEW.deleted_at IS NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_private.accounting_chain_writer_xids capability
      WHERE capability.transaction_id = txid_current()
        AND capability.backend_pid = pg_backend_pid()
    ) INTO v_core_writer;
    IF NOT v_core_writer THEN
      PERFORM app_private.begin_accounting_chain_write_v1();
      v_opened_writer := true;
    END IF;

    BEGIN
      UPDATE public.income_expenses
         SET approval_status = 'APPROVED',
             approved_by = NEW.approved_by,
             approved_at = NEW.approved_at,
             updated_at = now()
       WHERE id = CASE
           WHEN NEW.id = v_authorization.revenue_voucher_id
             THEN v_authorization.offset_voucher_id
           ELSE v_authorization.revenue_voucher_id
         END
         AND deleted_at IS NULL
         AND approval_status IS DISTINCT FROM 'APPROVED';

      SELECT validated.*
        INTO v_authorization
      FROM app_private.require_termination_forfeit_authorization_v1(
        NEW.id, true, false
      ) validated;

      IF NEW.id = v_authorization.revenue_voucher_id THEN
        v_pay_note := '[CẤN CỌC BỎ CỌC PAYMENT '
          || v_authorization.revenue_voucher_id::text || ']';

        IF v_authorization.payment_id IS NOT NULL THEN
          PERFORM app_private.require_termination_forfeit_payment_v1(
            v_authorization.revenue_voucher_id
          );
        ELSE
          PERFORM 1
          FROM public.payments payment
          WHERE payment.invoice_id = v_authorization.invoice_id
            AND payment.notes = v_pay_note
          FOR UPDATE;

          SELECT count(*)::integer,
                 (array_agg(payment.id ORDER BY payment.id))[1]
            INTO v_existing_count, v_payment_id
          FROM public.payments payment
          WHERE payment.invoice_id = v_authorization.invoice_id
            AND payment.notes = v_pay_note;

          IF v_existing_count > 1 THEN
            RAISE EXCEPTION 'Duplicate forfeit settlement payment markers detected'
              USING ERRCODE = '55000';
          ELSIF v_existing_count = 1 THEN
            UPDATE app_private.termination_forfeit_authorizations auth_row
               SET payment_id = v_payment_id
             WHERE auth_row.revenue_voucher_id =
               v_authorization.revenue_voucher_id
               AND auth_row.payment_id IS NULL;
            PERFORM app_private.require_termination_forfeit_payment_v1(
              v_authorization.revenue_voucher_id
            );
          ELSE
            IF EXISTS (
              SELECT 1
              FROM public.payments payment
              WHERE payment.invoice_id = v_authorization.invoice_id
                AND payment.reversed_at IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM app_private.payment_reversals reversal
                  WHERE reversal.original_payment_id = payment.id
                )
            ) OR NOT EXISTS (
              SELECT 1
              FROM public.invoices invoice
              WHERE invoice.id = v_authorization.invoice_id
                AND invoice.deleted_at IS NULL
                AND invoice.total_amount = v_authorization.amount
                AND COALESCE(invoice.paid_amount, 0) = 0
                AND COALESCE(invoice.remaining_amount, invoice.total_amount)
                  = v_authorization.amount
            ) THEN
              RAISE EXCEPTION 'Forfeit invoice already has settlement activity'
                USING ERRCODE = '55000';
            END IF;

            INSERT INTO public.payments (
              user_id, organization_id, invoice_id, amount, payment_method,
              payment_date, notes, received_amount, credit_amount,
              change_amount, rounding_amount
            )
            SELECT
              revenue.user_id, v_authorization.organization_id,
              v_authorization.invoice_id, v_authorization.amount,
              'CT'::public.payment_method,
              v_authorization.voucher_date, v_pay_note,
              0, 0, 0, 0
            FROM public.income_expenses revenue
            WHERE revenue.id = v_authorization.revenue_voucher_id
              AND revenue.approval_status = 'APPROVED'
              AND revenue.deleted_at IS NULL
            RETURNING id INTO v_payment_id;

            IF v_payment_id IS NULL THEN
              RAISE EXCEPTION 'Forfeit payment writer did not create a payment'
                USING ERRCODE = '55000';
            END IF;

            UPDATE app_private.termination_forfeit_authorizations auth_row
               SET payment_id = v_payment_id
             WHERE auth_row.revenue_voucher_id =
               v_authorization.revenue_voucher_id
               AND auth_row.payment_id IS NULL;
            PERFORM app_private.require_termination_forfeit_payment_v1(
              v_authorization.revenue_voucher_id
            );
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF v_opened_writer THEN
        PERFORM app_private.end_accounting_chain_write_v1();
      END IF;
      RAISE;
    END;

    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.approval_status IN ('UNAPPROVED', 'CANCELLED')
     AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_private.accounting_chain_writer_xids capability
      WHERE capability.transaction_id = txid_current()
        AND capability.backend_pid = pg_backend_pid()
    ) INTO v_core_writer;
    IF NOT v_core_writer THEN
      PERFORM app_private.begin_accounting_chain_write_v1();
      v_opened_writer := true;
    END IF;

    BEGIN
      SELECT auth_row.payment_id
        INTO v_payment_id
      FROM app_private.termination_forfeit_authorizations auth_row
      WHERE auth_row.revenue_voucher_id =
        v_authorization.revenue_voucher_id
      FOR UPDATE;

      IF v_payment_id IS NOT NULL THEN
        PERFORM app_private.require_termination_forfeit_payment_v1(
          v_authorization.revenue_voucher_id
        );
        UPDATE app_private.termination_forfeit_authorizations auth_row
           SET payment_id = NULL
         WHERE auth_row.revenue_voucher_id =
           v_authorization.revenue_voucher_id
           AND auth_row.payment_id = v_payment_id;
        DELETE FROM public.payments payment
        WHERE payment.id = v_payment_id;
      END IF;

      UPDATE public.income_expenses
         SET approval_status = NEW.approval_status,
             approved_by = NULL,
             approved_at = NULL,
             updated_at = now()
       WHERE id = CASE
           WHEN NEW.id = v_authorization.revenue_voucher_id
             THEN v_authorization.offset_voucher_id
           ELSE v_authorization.revenue_voucher_id
         END
         AND deleted_at IS NULL
         AND approval_status IS DISTINCT FROM NEW.approval_status;
    EXCEPTION WHEN OTHERS THEN
      IF v_opened_writer THEN
        PERFORM app_private.end_accounting_chain_write_v1();
      END IF;
      RAISE;
    END;

    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_forfeit_settle_on_approve
  ON public.income_expenses;
CREATE TRIGGER trg_forfeit_settle_on_approve
AFTER UPDATE OF approval_status ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION public.trg_forfeit_settle_on_approve();

REVOKE ALL ON FUNCTION public.trg_forfeit_settle_on_approve()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_termination_forfeit_status_v1(
  p_voucher_id uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_authorization app_private.termination_forfeit_authorizations%ROWTYPE;
  v_building uuid;
  v_allowed boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF upper(COALESCE(p_status, '')) NOT IN (
    'APPROVED', 'UNAPPROVED', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Unsupported forfeit voucher status'
      USING ERRCODE = '22023';
  END IF;

  SELECT auth_row.*
    INTO v_authorization
  FROM app_private.termination_forfeit_authorizations auth_row
  WHERE auth_row.revenue_voucher_id = p_voucher_id
     OR auth_row.offset_voucher_id = p_voucher_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher is not a termination forfeit pair'
      USING ERRCODE = '55000';
  END IF;

  -- Lock both legs before changing either one so opposite-leg requests cannot
  -- acquire the pair in a conflicting order.
  PERFORM 1
  FROM public.income_expenses voucher
  WHERE voucher.id IN (
    v_authorization.revenue_voucher_id,
    v_authorization.offset_voucher_id
  )
  ORDER BY voucher.id
  FOR UPDATE;

  SELECT room_row.building_id
    INTO v_building
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = v_authorization.contract_id
    AND contract_row.organization_id = v_authorization.organization_id;

  PERFORM app_private.lock_org_for_decision_v1(
    v_authorization.organization_id
  );
  SELECT decision.allowed
    INTO v_allowed
  FROM app_private.authorize_tenant_action_v3(
    v_actor,
    v_authorization.organization_id,
    'income_expenses.approve',
    v_building,
    NULL
  ) decision;
  IF NOT (public.is_super_admin() OR COALESCE(v_allowed, false)) THEN
    RAISE EXCEPTION 'Missing elevated permission to change forfeit voucher status'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.assert_no_engine_request_v1(
    v_authorization.revenue_voucher_id
  );
  PERFORM app_private.assert_no_engine_request_v1(
    v_authorization.offset_voucher_id
  );

  IF upper(p_status) <> 'CANCELLED' AND EXISTS (
    SELECT 1
    FROM public.income_expenses voucher
    WHERE voucher.id IN (
      v_authorization.revenue_voucher_id,
      v_authorization.offset_voucher_id
    )
      AND voucher.approval_status = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Cancelled forfeit vouchers are terminal'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;
  IF NOT v_core_writer THEN
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  BEGIN
    INSERT INTO app_private.ie_transition_authorization (
      income_expense_id, xid, purpose
    ) VALUES
      (
        v_authorization.revenue_voucher_id,
        pg_current_xact_id(),
        upper(p_status)
      ),
      (
        v_authorization.offset_voucher_id,
        pg_current_xact_id(),
        upper(p_status)
      );

    UPDATE public.income_expenses voucher
       SET approval_status = upper(p_status),
           approved_by = CASE
             WHEN upper(p_status) = 'APPROVED' THEN v_actor
             ELSE NULL
           END,
           approved_at = CASE
             WHEN upper(p_status) = 'APPROVED' THEN now()
             ELSE NULL
           END,
           updated_at = now()
     WHERE voucher.id = v_authorization.revenue_voucher_id
       AND voucher.deleted_at IS NULL
       AND voucher.approval_status IS DISTINCT FROM upper(p_status);

    DELETE FROM app_private.ie_transition_authorization transition_row
    WHERE transition_row.income_expense_id IN (
      v_authorization.revenue_voucher_id,
      v_authorization.offset_voucher_id
    )
      AND transition_row.xid = pg_current_xact_id();
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.ie_transition_authorization transition_row
    WHERE transition_row.income_expense_id IN (
      v_authorization.revenue_voucher_id,
      v_authorization.offset_voucher_id
    )
      AND transition_row.xid = pg_current_xact_id();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_termination_forfeit_status_v1(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_termination_forfeit_status_v1(uuid, text)
  TO authenticated, service_role;

-- A deployment that applies files separately must still fail closed if a
-- legacy termination call inserted a cash-looking offset after history repair
-- but before the protective trigger existed.
DO $assert_no_termination_migration_gap$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payments payment
    WHERE payment.reversed_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app_private.payment_reversals reversal
        WHERE reversal.original_payment_id = payment.id
      )
      AND COALESCE(payment.notes, '') ~
        '^Quyết toán khi thanh lý [0-9]{2}/[0-9]{2}/[0-9]{4}( \(cấn cọc\))?$'
      AND (
        payment.received_amount IS DISTINCT FROM 0
        OR COALESCE(payment.credit_amount, 0) <> 0
        OR COALESCE(payment.change_amount, 0) <> 0
        OR COALESCE(payment.rounding_amount, 0) <> 0
        OR payment.collection_id IS NOT NULL
        OR payment.tender_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Termination payment appeared between history repair and protection; rerun the atomic accounting rollout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payments payment
    LEFT JOIN app_private.termination_forfeit_authorizations auth_row
      ON auth_row.payment_id = payment.id
    WHERE payment.reversed_at IS NULL
      AND COALESCE(payment.notes, '') ~
        '^\[CẤN CỌC BỎ CỌC PAYMENT [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]$'
      AND auth_row.revenue_voucher_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Unprovenanced termination forfeit payment appeared during rollout';
  END IF;
END
$assert_no_termination_migration_gap$;

DO $assert_forfeit_runtime$
DECLARE
  v_row record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    JOIN pg_catalog.pg_class table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
    WHERE schema_row.nspname = 'public'
      AND table_row.relname = 'income_expenses'
      AND trigger_row.tgname = 'trg_forfeit_settle_on_approve'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Forfeit settlement approval trigger is missing or disabled';
  END IF;

  FOR v_row IN
    SELECT
      auth_row.revenue_voucher_id,
      auth_row.payment_id,
      revenue.approval_status AS revenue_status,
      offset_voucher.approval_status AS offset_status
    FROM app_private.termination_forfeit_authorizations auth_row
    JOIN public.income_expenses revenue
      ON revenue.id = auth_row.revenue_voucher_id
    JOIN public.income_expenses offset_voucher
      ON offset_voucher.id = auth_row.offset_voucher_id
    ORDER BY auth_row.revenue_voucher_id
  LOOP
    PERFORM app_private.require_termination_forfeit_authorization_v1(
      v_row.revenue_voucher_id, false, true
    );
    IF v_row.revenue_status IS DISTINCT FROM v_row.offset_status THEN
      RAISE EXCEPTION 'Forfeit authorization has mixed voucher statuses';
    END IF;
    IF v_row.revenue_status = 'APPROVED' THEN
      IF v_row.payment_id IS NULL THEN
        RAISE EXCEPTION 'Approved forfeit authorization has no payment provenance';
      END IF;
      PERFORM app_private.require_termination_forfeit_payment_v1(
        v_row.revenue_voucher_id
      );
    ELSIF v_row.payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Non-approved forfeit authorization retains a payment';
    END IF;
  END LOOP;
END
$assert_forfeit_runtime$;

COMMIT;

NOTIFY pgrst, 'reload schema';
