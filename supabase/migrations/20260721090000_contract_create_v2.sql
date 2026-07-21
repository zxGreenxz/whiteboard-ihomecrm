-- Atomic contract creation V2.
--
-- ROLLBACK: set contract.create.v2 OFF, restore the previous extension/orphan
-- trigger functions, revoke/drop create_contract_v2, then drop the two indexes
-- and contract_deposit_links only after proving no V2 rows depend on them.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contract_deposit_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  link_source text NOT NULL DEFAULT 'EXPLICIT_V2',
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contract_deposit_links_source_check
    CHECK (link_source IN ('EXPLICIT_V2', 'BACKFILL_REVIEWED')),
  CONSTRAINT contract_deposit_links_voucher_unique UNIQUE (income_expense_id),
  CONSTRAINT contract_deposit_links_contract_voucher_unique UNIQUE (contract_id, income_expense_id)
);

CREATE INDEX IF NOT EXISTS contract_deposit_links_contract_idx
  ON public.contract_deposit_links(contract_id);
CREATE INDEX IF NOT EXISTS contract_deposit_links_org_idx
  ON public.contract_deposit_links(organization_id);

ALTER TABLE public.contract_deposit_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_deposit_links_select ON public.contract_deposit_links;
CREATE POLICY contract_deposit_links_select
ON public.contract_deposit_links FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.contracts contract_row
    JOIN public.rooms room_row ON room_row.id = contract_row.room_id
    WHERE contract_row.id = contract_deposit_links.contract_id
      AND contract_row.organization_id = contract_deposit_links.organization_id
      AND public.can_access_building(room_row.building_id)
  )
);

REVOKE ALL ON public.contract_deposit_links
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.contract_deposit_links TO authenticated;

DO $deposit_link_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.contract_deposit_links link_row
    JOIN public.contracts contract_row ON contract_row.id = link_row.contract_id
    JOIN public.income_expenses voucher ON voucher.id = link_row.income_expense_id
    WHERE link_row.organization_id <> contract_row.organization_id
       OR link_row.organization_id <> voucher.organization_id
       OR voucher.room_id IS DISTINCT FROM contract_row.room_id
       OR (
         voucher.contract_id IS NOT NULL
         AND voucher.contract_id <> link_row.contract_id
       )
  ) THEN
    RAISE EXCEPTION 'Existing contract deposit link conflicts with voucher lifecycle';
  END IF;

  UPDATE public.income_expenses voucher
     SET contract_id = link_row.contract_id,
         updated_at = now()
    FROM public.contract_deposit_links link_row
   WHERE link_row.income_expense_id = voucher.id
     AND voucher.contract_id IS NULL;
END
$deposit_link_backfill$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.contracts
    WHERE deleted_at IS NULL AND status = 'ACTIVE'
    GROUP BY room_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add active-contract uniqueness: duplicate ACTIVE rooms exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.contract_customers
    WHERE is_representative
    GROUP BY contract_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add representative uniqueness: duplicate representatives exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS contracts_one_active_per_room_uq
  ON public.contracts(room_id)
  WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS contract_customers_one_representative_uq
  ON public.contract_customers(contract_id)
  WHERE is_representative;

CREATE OR REPLACE FUNCTION public.compute_first_billing_month_v2(
  p_start_date date,
  p_end_date date
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  WITH bounds AS (
    SELECT LEAST(p_start_date, p_end_date) AS from_date,
           GREATEST(p_start_date, p_end_date) AS to_date
  ), full_months AS (
    SELECT month_start::date
    FROM bounds,
         LATERAL generate_series(
           date_trunc('month', from_date),
           date_trunc('month', to_date),
           interval '1 month'
         ) month_start
    WHERE month_start::date >= from_date
      AND (month_start + interval '1 month - 1 day')::date <= to_date
    ORDER BY month_start DESC
    LIMIT 1
  )
  SELECT to_char(
    COALESCE(
      (SELECT month_start FROM full_months),
      date_trunc('month', p_start_date)::date
    ),
    'YYYY-MM'
  );
$$;

REVOKE ALL ON FUNCTION public.compute_first_billing_month_v2(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_first_billing_month_v2(date, date) TO authenticated;

-- Legacy clients keep the old heuristic briefly. V2 explicitly opts out and
-- links only voucher IDs selected by the user.
CREATE OR REPLACE FUNCTION public.trg_contract_link_orphan_deposits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.contract_create_v2', true) = 'on' OR NEW.room_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.income_expenses voucher
     SET contract_id = NEW.id,
         updated_at = now()
   WHERE voucher.contract_id IS NULL
     AND voucher.organization_id = NEW.organization_id
     AND voucher.deleted_at IS NULL
     AND voucher.approval_status = 'APPROVED'
     AND voucher.type = 'INCOME'
     AND voucher.room_id = NEW.room_id
     AND voucher.voucher_date BETWEEN NEW.start_date - interval '30 days'
                                  AND NEW.start_date + interval '7 days'
     AND EXISTS (
       SELECT 1
       FROM public.income_expense_items item
       WHERE item.income_expense_id = voucher.id
         AND item.accounting_class = 'DEPOSIT'
     );

  PERFORM public.recompute_contract_deposit_paid(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric(15,2) := 0;
  v_count_any integer := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(
      CASE WHEN voucher.type = 'EXPENSE' THEN -1 ELSE 1 END
      * COALESCE(item.amount, item.unit_price * item.quantity)
    ) FILTER (
      WHERE voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL
    ), 0),
    COUNT(*)
  INTO v_total, v_count_any
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
   AND item.accounting_class = 'DEPOSIT'
  LEFT JOIN public.contract_deposit_links link_row
    ON link_row.income_expense_id = voucher.id
   AND link_row.contract_id = p_contract_id
  WHERE voucher.contract_id = p_contract_id OR link_row.id IS NOT NULL;

  IF v_count_any > 0 THEN
    UPDATE public.contracts
       SET deposit_paid = GREATEST(v_total, 0),
           updated_at = now()
     WHERE id = p_contract_id
       AND deleted_at IS NULL
       AND deposit_paid IS DISTINCT FROM GREATEST(v_total, 0);
  END IF;
END;
$$;

-- The old extension inserted the replacement ACTIVE contract before expiring
-- the source contract. Reverse that order so the DB uniqueness invariant holds.
CREATE OR REPLACE FUNCTION public.create_new_contract_extension(
  p_contract_id uuid,
  p_extension_months integer,
  p_new_rent_price numeric DEFAULT NULL,
  p_new_deposit numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_old_contract public.contracts%ROWTYPE;
  v_new_contract_id uuid;
  v_extension_id uuid;
  v_new_end_date date;
  v_new_start_date date;
  v_building_id uuid;
  v_authz boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_extension_months IS NULL OR p_extension_months <= 0 THEN
    RAISE EXCEPTION 'extension_months must be positive' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_new_rent_price::text, '') IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE(p_new_deposit::text, '') IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE(p_new_rent_price, 0) < 0
     OR COALESCE(p_new_deposit, 0) < 0 THEN
    RAISE EXCEPTION 'New rent/deposit is not a finite non-negative amount'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.*
    INTO v_old_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.organizations org_row
    ON org_row.id = contract_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE contract_row.id = p_contract_id
    AND contract_row.status = 'ACTIVE'
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active' USING ERRCODE = '42501';
  END IF;

  SELECT room_row.building_id INTO v_building_id
  FROM public.rooms room_row
  WHERE room_row.id = v_old_contract.room_id
    AND room_row.deleted_at IS NULL
  FOR SHARE;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Contract room is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_old_contract.organization_id);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_old_contract.organization_id, 'contracts.renew', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Not authorized to renew this contract' USING ERRCODE = '42501';
  END IF;

  v_new_start_date := v_old_contract.end_date + 1;
  v_new_end_date := (
    v_new_start_date + (p_extension_months || ' months')::interval - interval '1 day'
  )::date;

  UPDATE public.contracts
     SET status = 'EXPIRED', updated_at = now()
   WHERE id = p_contract_id;

  INSERT INTO public.contracts (
    user_id, organization_id, tenant_id, room_id, contract_number, status,
    signed_date, start_date, end_date, rent_price, payment_cycle,
    total_deposit, deposit_paid, parent_contract_id, notes,
    start_billing_date, end_billing_date, contract_template_id, invoice_template_id
  ) VALUES (
    v_old_contract.user_id, v_old_contract.organization_id, v_old_contract.tenant_id,
    v_old_contract.room_id, NULL, 'ACTIVE', current_date,
    v_new_start_date, v_new_end_date,
    COALESCE(p_new_rent_price, v_old_contract.rent_price),
    v_old_contract.payment_cycle,
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    LEAST(
      v_old_contract.deposit_paid,
      COALESCE(p_new_deposit, v_old_contract.total_deposit)
    ),
    p_contract_id,
    COALESCE(p_notes, 'Gia hạn từ HĐ: ' || COALESCE(v_old_contract.contract_number, p_contract_id::text)),
    v_new_start_date, v_new_end_date,
    v_old_contract.contract_template_id, v_old_contract.invoice_template_id
  ) RETURNING id INTO v_new_contract_id;

  INSERT INTO public.contract_customers (
    organization_id, contract_id, customer_id, is_representative, notes
  )
  SELECT organization_id, v_new_contract_id, customer_id, is_representative, notes
  FROM public.contract_customers
  WHERE contract_id = p_contract_id;

  INSERT INTO public.contract_services (
    organization_id, contract_id, service_id, unit_price, initial_reading
  )
  SELECT organization_id, v_new_contract_id, service_id, unit_price, initial_reading
  FROM public.contract_services
  WHERE contract_id = p_contract_id;

  INSERT INTO public.contract_extensions (
    user_id, contract_id, extension_type, old_end_date, extension_months,
    new_end_date, new_rent_price, rent_price_changed, new_deposit,
    deposit_changed, new_contract_id, notes, status
  ) VALUES (
    v_actor, p_contract_id, 'CREATE_NEW', v_old_contract.end_date,
    p_extension_months, v_new_end_date, p_new_rent_price,
    p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_old_contract.rent_price,
    p_new_deposit,
    p_new_deposit IS NOT NULL AND p_new_deposit <> v_old_contract.total_deposit,
    v_new_contract_id, p_notes, 'COMPLETED'
  ) RETURNING id INTO v_extension_id;

  RETURN v_new_contract_id;
END;
$$;

INSERT INTO app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, reason
)
VALUES (
  'contract.create.v2', 'contracts', 'MONEY', 'SHADOW',
  'Atomic contract, deposit and first-invoice creation'
)
ON CONFLICT (feature_key) DO UPDATE
SET domain = EXCLUDED.domain,
    risk_class = EXCLUDED.risk_class,
    reason = EXCLUDED.reason,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.create_contract_v2(
  p_payload jsonb,
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
  v_contract_json jsonb := COALESCE(p_payload->'contract', '{}'::jsonb);
  v_customers jsonb := COALESCE(p_payload->'customers', '[]'::jsonb);
  v_services jsonb := COALESCE(p_payload->'services', '[]'::jsonb);
  v_receipts jsonb := COALESCE(p_payload->'deposit_receipts', '[]'::jsonb);
  v_existing_deposits jsonb := COALESCE(p_payload->'existing_deposit_voucher_ids', '[]'::jsonb);
  v_first_invoice jsonb := p_payload->'first_invoice';
  v_room_id uuid;
  v_building_id uuid;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_payload_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_contract_id uuid;
  v_invoice_id uuid;
  v_customer jsonb;
  v_service jsonb;
  v_receipt jsonb;
  v_item jsonb;
  v_voucher_id uuid;
  v_deposit_type_id uuid;
  v_account_id uuid;
  v_total_deposit numeric;
  v_deposit_paid numeric := 0;
  v_new_deposit_receipts numeric := 0;
  v_deposit_shortfall numeric := 0;
  v_debt_mode text;
  v_debt_reason text;
  v_debt_due date;
  v_start_date date;
  v_end_date date;
  v_signed_date date;
  v_start_billing date;
  v_end_billing date;
  v_billing_month text;
  v_issue_date date;
  v_due_date date;
  v_subtotal numeric := 0;
  v_revenue_subtotal numeric := 0;
  v_deposit_invoice_total numeric := 0;
  v_discount numeric := 0;
  v_revenue_after_discount numeric := 0;
  v_rounded_revenue numeric := 0;
  v_total_amount numeric := 0;
  v_remainder numeric := 0;
  v_rep_count integer;
  v_customer_count integer;
  v_distinct_customer_count integer;
  v_locked_customer_count integer;
  v_deposit_item_count integer := 0;
  v_contract_row jsonb;
  v_invoice_row jsonb := NULL;
  v_response jsonb;
  v_idx integer := 0;
  v_amount numeric;
  v_qty numeric;
  v_unit numeric;
  v_item_from date;
  v_item_to date;
  v_class text;
  v_type text;
  v_service_id uuid;
  v_room_name text;
  v_building_name text;
  v_room_status public.room_status;
  v_contract_template_id uuid;
  v_invoice_template_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(v_customers) <> 'array'
     OR jsonb_typeof(v_services) <> 'array'
     OR jsonb_typeof(v_receipts) <> 'array'
     OR jsonb_typeof(v_existing_deposits) <> 'array' THEN
    RAISE EXCEPTION 'Payload contract V2 không hợp lệ' USING ERRCODE = '22023';
  END IF;

  v_room_id := NULLIF(v_contract_json->>'room_id', '')::uuid;
  v_start_date := NULLIF(v_contract_json->>'start_date', '')::date;
  v_end_date := NULLIF(v_contract_json->>'end_date', '')::date;
  v_signed_date := COALESCE(NULLIF(v_contract_json->>'signed_date', '')::date, v_start_date);
  v_start_billing := COALESCE(NULLIF(v_contract_json->>'start_billing_date', '')::date, v_start_date);
  v_end_billing := COALESCE(NULLIF(v_contract_json->>'end_billing_date', '')::date, v_start_billing);
  v_total_deposit := COALESCE((v_contract_json->>'total_deposit')::numeric, 0);
  v_debt_mode := NULLIF(v_contract_json->>'deposit_debt_mode', '');
  v_debt_reason := NULLIF(btrim(v_contract_json->>'deposit_debt_reason'), '');
  v_debt_due := NULLIF(v_contract_json->>'deposit_topup_due_date', '')::date;
  v_contract_template_id := NULLIF(v_contract_json->>'contract_template_id', '')::uuid;
  v_invoice_template_id := NULLIF(v_contract_json->>'invoice_template_id', '')::uuid;

  IF v_room_id IS NULL OR v_start_date IS NULL OR v_end_date IS NULL OR v_start_date > v_end_date THEN
    RAISE EXCEPTION 'Phòng hoặc ngày hợp đồng không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF v_start_billing IS NULL OR v_end_billing IS NULL OR v_start_billing > v_end_billing THEN
    RAISE EXCEPTION 'Kỳ tính tiền đầu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF v_start_billing < v_start_date OR v_end_billing > v_end_date THEN
    RAISE EXCEPTION 'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE((v_contract_json->>'rent_price')::numeric, -1)::text
       IN ('NaN', 'Infinity', '-Infinity')
     OR v_total_deposit::text IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE((v_contract_json->>'rent_price')::numeric, -1) < 0
     OR v_total_deposit < 0 THEN
    RAISE EXCEPTION 'Giá thuê hoặc tiền cọc không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT room_row.building_id, building_row.organization_id, building_row.user_id,
         room_row.name, building_row.name, room_row.status
    INTO v_building_id, v_org, v_owner, v_room_name, v_building_name, v_room_status
  FROM public.rooms room_row
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE room_row.id = v_room_id
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
  FOR UPDATE OF room_row;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức đang hoạt động'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'contracts.create', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng' USING ERRCODE = '42501';
  END IF;

  v_payload_hash := md5(jsonb_build_object('organization_id', v_org, 'payload', p_payload)::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.create.v2', v_room_id::text || '|' || v_start_date::text,
    v_actor, v_key, v_payload_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.create.v2'
    AND operation_row.subject_scope = v_room_id::text || '|' || v_start_date::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_payload_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF v_room_status NOT IN ('AVAILABLE', 'RESERVED') THEN
    RAISE EXCEPTION 'Trạng thái phòng không cho phép tạo hợp đồng: %', v_room_status
      USING ERRCODE = '55000';
  END IF;

  v_route := app_private.evaluate_feature_route('contract.create.v2', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer contract.create.v2 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer contract.create.v2 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contracts contract_row
    WHERE contract_row.room_id = v_room_id
      AND contract_row.deleted_at IS NULL
      AND contract_row.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Phòng đã có hợp đồng đang hiệu lực' USING ERRCODE = '23505';
  END IF;

  UPDATE public.room_reservation_holds
     SET status = 'EXPIRED'
   WHERE room_id = v_room_id
     AND status = 'PENDING_APPROVAL'
     AND expires_at <= clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM public.room_reservation_holds hold_row
    WHERE hold_row.room_id = v_room_id
      AND hold_row.status = 'PENDING_APPROVAL'
      AND hold_row.expires_at > clock_timestamp()
      AND hold_row.held_by <> v_actor
  ) THEN
    RAISE EXCEPTION 'Phòng đang được người khác giữ chỗ' USING ERRCODE = '55P03';
  END IF;

  SELECT count(*), count(DISTINCT customer_row->>'customer_id'),
         count(*) FILTER (WHERE COALESCE((customer_row->>'is_representative')::boolean, false))
    INTO v_customer_count, v_distinct_customer_count, v_rep_count
  FROM jsonb_array_elements(v_customers) customer_row;

  IF v_customer_count = 0 OR v_customer_count <> v_distinct_customer_count OR v_rep_count <> 1 THEN
    RAISE EXCEPTION 'Hợp đồng cần danh sách khách không trùng và đúng một người đại diện'
      USING ERRCODE = '22023';
  END IF;

  -- Preserve tenant/deletion validation while concurrent contract creates share
  -- customer locks acquired in one deterministic UUID order.
  WITH requested_customers AS MATERIALIZED (
    SELECT (requested.value->>'customer_id')::uuid AS customer_id
    FROM jsonb_array_elements(v_customers) AS requested(value)
  ), locked_customers AS MATERIALIZED (
    SELECT customer_row.id
    FROM public.customers customer_row
    JOIN requested_customers requested
      ON requested.customer_id = customer_row.id
    WHERE customer_row.deleted_at IS NULL
      AND customer_row.organization_id = v_org
    ORDER BY customer_row.id
    FOR SHARE OF customer_row
  )
  SELECT count(*)
    INTO v_locked_customer_count
  FROM locked_customers;

  IF v_locked_customer_count <> v_customer_count THEN
    RAISE EXCEPTION 'Khách hàng không thuộc tổ chức' USING ERRCODE = '42501';
  END IF;

  FOR v_service IN SELECT value FROM jsonb_array_elements(v_services) LOOP
    IF COALESCE((v_service->>'unit_price')::numeric, -1)::text
         IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE(NULLIF(v_service->>'initial_reading', '')::numeric, 0)::text
         IN ('NaN', 'Infinity', '-Infinity')
       OR COALESCE((v_service->>'unit_price')::numeric, -1) < 0 THEN
      RAISE EXCEPTION 'Đơn giá dịch vụ không hợp lệ' USING ERRCODE = '22023';
    END IF;
    PERFORM 1
    FROM public.services service_row
    WHERE service_row.id = (v_service->>'service_id')::uuid
      AND service_row.organization_id = v_org
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dịch vụ không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF v_contract_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.document_templates template_row
    WHERE template_row.id = v_contract_template_id
      AND template_row.organization_id = v_org
      AND template_row.category = 'CONTRACT_NEW'
      AND COALESCE(template_row.is_active, true)
      AND template_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mẫu hợp đồng không thuộc tổ chức hoặc không còn hiệu lực'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_invoice_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.document_templates template_row
    WHERE template_row.id = v_invoice_template_id
      AND template_row.organization_id = v_org
      AND template_row.category = 'INVOICE'
      AND COALESCE(template_row.is_active, true)
      AND template_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mẫu hóa đơn không thuộc tổ chức hoặc không còn hiệu lực'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1
  FOR SHARE;

  IF (jsonb_array_length(v_receipts) > 0 OR jsonb_array_length(v_existing_deposits) > 0)
     AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc is_deposit' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('app.contract_create_v2', 'on', true);

  INSERT INTO public.contracts (
    user_id, organization_id, tenant_id, room_id, status,
    signed_date, start_date, end_date, rent_price, payment_cycle,
    total_deposit, deposit_paid, start_billing_date, end_billing_date,
    contract_template_id, invoice_template_id, notes, discounts,
    deposit_debt_acknowledged, deposit_debt_mode, deposit_debt_reason,
    deposit_topup_due_date
  ) VALUES (
    v_owner, v_org, NULL, v_room_id, 'ACTIVE',
    v_signed_date, v_start_date, v_end_date,
    (v_contract_json->>'rent_price')::numeric,
    COALESCE(NULLIF(v_contract_json->>'payment_cycle', '')::public.payment_cycle, 'MONTHLY'),
    v_total_deposit, 0, v_start_billing, v_end_billing,
    v_contract_template_id,
    v_invoice_template_id,
    NULLIF(v_contract_json->>'notes', ''),
    COALESCE(v_contract_json->'discounts', '[]'::jsonb),
    false, NULL, NULL, NULL
  ) RETURNING id INTO v_contract_id;

  FOR v_customer IN SELECT value FROM jsonb_array_elements(v_customers) LOOP
    INSERT INTO public.contract_customers (
      organization_id, contract_id, customer_id, is_representative, notes
    ) VALUES (
      v_org, v_contract_id, (v_customer->>'customer_id')::uuid,
      COALESCE((v_customer->>'is_representative')::boolean, false),
      NULLIF(v_customer->>'notes', '')
    );
  END LOOP;

  FOR v_service IN SELECT value FROM jsonb_array_elements(v_services) LOOP
    INSERT INTO public.contract_services (
      organization_id, contract_id, service_id, unit_price, initial_reading
    ) VALUES (
      v_org, v_contract_id, (v_service->>'service_id')::uuid,
      (v_service->>'unit_price')::numeric,
      NULLIF(v_service->>'initial_reading', '')::numeric
    );
  END LOOP;

  IF jsonb_array_length(v_existing_deposits) <> (
    SELECT count(DISTINCT value #>> '{}') FROM jsonb_array_elements(v_existing_deposits)
  ) THEN
    RAISE EXCEPTION 'Danh sách phiếu cọc có ID trùng' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_existing_deposits) LOOP
    SELECT voucher.id INTO v_voucher_id
    FROM public.income_expenses voucher
    WHERE voucher.id = (v_item #>> '{}')::uuid
      AND voucher.organization_id = v_org
      AND voucher.room_id = v_room_id
      AND voucher.contract_id IS NULL
      AND voucher.type = 'INCOME'
      AND voucher.approval_status = 'APPROVED'
      AND voucher.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
          AND item.accounting_class = 'DEPOSIT'
      )
    FOR SHARE;

    IF v_voucher_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu cọc được chọn không hợp lệ hoặc đã được dùng'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.contract_deposit_links (
      organization_id, contract_id, income_expense_id, link_source, linked_by
    ) VALUES (
      v_org, v_contract_id, v_voucher_id, 'EXPLICIT_V2', v_actor
    );

    -- Keep the legacy lifecycle field in sync so linked reservation deposits
    -- immediately leave orphan/holding-deposit queries as well as the link table.
    UPDATE public.income_expenses
       SET contract_id = v_contract_id,
           updated_at = now()
     WHERE id = v_voucher_id
       AND contract_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng'
        USING ERRCODE = '40001';
    END IF;
    v_voucher_id := NULL;
  END LOOP;

  FOR v_receipt IN SELECT value FROM jsonb_array_elements(v_receipts) LOOP
    v_amount := COALESCE((v_receipt->>'amount')::numeric, 0);
    IF v_amount::text IN ('NaN', 'Infinity', '-Infinity') OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Số tiền cọc phải lớn hơn 0' USING ERRCODE = '22023';
    END IF;
    v_new_deposit_receipts := v_new_deposit_receipts + v_amount;

    v_account_id := NULLIF(v_receipt->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      SELECT account_row.id INTO v_account_id
      FROM public.accounts account_row
      WHERE account_row.organization_id = v_org
        AND account_row.user_id = v_actor
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
      ORDER BY account_row.is_default DESC,
               CASE WHEN account_row.name ILIKE '%thu' THEN 0 ELSE 1 END,
               account_row.created_at
      LIMIT 1
      FOR SHARE;
      IF v_account_id IS NULL THEN
        RAISE EXCEPTION 'Chưa chọn sổ quỹ nhận cọc trong tổ chức'
          USING ERRCODE = '22023';
      END IF;
    END IF;
    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ cọc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;

    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi tiền cọc vào sổ đã chọn' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, voucher_date, total_amount, approval_status, approved_by,
      approved_at, attachments, business_result_accounting, creator_name,
      system_source, idempotency_key
    ) VALUES (
      v_owner, v_org, 'INCOME',
      'Cọc giữ phòng ' || COALESCE(v_room_name, '') || ' ' || COALESCE(v_building_name, ''),
      v_building_id, v_room_id, v_contract_id, v_account_id,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      v_amount, 'APPROVED', v_actor, clock_timestamp(),
      COALESCE(v_receipt->'attachments', '[]'::jsonb), NULL,
      COALESCE(NULLIF(v_receipt->>'creator_name', ''), 'Contract V2'),
      'contract.create.v2', v_key || ':deposit:' || v_idx
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO public.income_expense_items (
      income_expense_id, organization_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date, accounting_class
    ) VALUES (
      v_voucher_id, v_org, v_deposit_type_id, 'Tiền cọc hợp đồng',
      1, v_amount, v_amount,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      'DEPOSIT'
    );
    v_idx := v_idx + 1;
  END LOOP;

  PERFORM public.recompute_contract_deposit_paid(v_contract_id);
  SELECT COALESCE(contract_row.deposit_paid, 0)
    INTO v_deposit_paid
  FROM public.contracts contract_row
  WHERE contract_row.id = v_contract_id
  FOR UPDATE;

  v_deposit_shortfall := GREATEST(v_total_deposit - v_deposit_paid, 0);
  IF v_deposit_paid - v_total_deposit >= 0.01 THEN
    RAISE EXCEPTION 'Tiền cọc đã nhận vượt số cọc của hợp đồng'
      USING ERRCODE = '22023';
  END IF;
  IF v_deposit_shortfall >= 0.01 THEN
    IF v_debt_mode NOT IN ('DEBT', 'FIRST_INVOICE') THEN
      RAISE EXCEPTION 'Thiếu cọc: phải chọn DEBT hoặc FIRST_INVOICE'
        USING ERRCODE = '22023';
    END IF;
    IF v_debt_mode = 'DEBT' AND (v_debt_reason IS NULL OR v_debt_due IS NULL) THEN
      RAISE EXCEPTION 'Nợ cọc cần lý do và hạn bổ sung' USING ERRCODE = '22023';
    END IF;
    IF v_debt_mode = 'FIRST_INVOICE' AND v_first_invoice IS NULL THEN
      RAISE EXCEPTION 'FIRST_INVOICE cần hóa đơn đầu' USING ERRCODE = '22023';
    END IF;

    UPDATE public.contracts
       SET deposit_debt_acknowledged = true,
           deposit_debt_mode = v_debt_mode,
           deposit_debt_reason = CASE WHEN v_debt_mode = 'DEBT' THEN v_debt_reason END,
           deposit_topup_due_date = CASE WHEN v_debt_mode = 'DEBT' THEN v_debt_due END
     WHERE id = v_contract_id;
  ELSE
    v_debt_mode := NULL;
  END IF;

  IF v_first_invoice IS NOT NULL THEN
    IF jsonb_typeof(COALESCE(v_first_invoice->'items', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_first_invoice->'items', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'Hóa đơn đầu cần ít nhất một hạng mục' USING ERRCODE = '22023';
    END IF;

    v_subtotal := 0;
    v_revenue_subtotal := 0;
    v_deposit_invoice_total := 0;
    v_deposit_item_count := 0;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_first_invoice->'items') LOOP
      v_type := COALESCE(NULLIF(v_item->>'type', ''), 'OTHER');
      v_class := COALESCE(NULLIF(v_item->>'accounting_class', ''), 'REVENUE');
      v_unit := COALESCE((v_item->>'unit_price')::numeric, -1);
      v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
      v_service_id := NULLIF(v_item->>'service_id', '')::uuid;
      v_item_from := NULLIF(v_item->>'from_date', '')::date;
      v_item_to := NULLIF(v_item->>'to_date', '')::date;

      IF v_type NOT IN ('RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER')
         OR v_class NOT IN ('REVENUE', 'DEPOSIT')
         OR v_unit::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_qty::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_unit < 0 OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Hạng mục hóa đơn đầu không hợp lệ' USING ERRCODE = '22023';
      END IF;
      IF (v_item_from IS NULL) <> (v_item_to IS NULL) THEN
        RAISE EXCEPTION 'Kỳ hạng mục hóa đơn phải có đủ từ ngày và đến ngày'
          USING ERRCODE = '22023';
      END IF;
      IF v_item_from IS NOT NULL AND v_item_from > v_item_to THEN
        RAISE EXCEPTION 'Kỳ hạng mục hóa đơn bị đảo ngày' USING ERRCODE = '22023';
      END IF;
      IF v_class = 'REVENUE'
         AND (
           COALESCE(v_item_from, v_start_billing) < v_start_billing
           OR COALESCE(v_item_to, v_end_billing) > v_end_billing
         ) THEN
        RAISE EXCEPTION 'Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu'
          USING ERRCODE = '22023';
      END IF;
      IF v_class = 'DEPOSIT' AND v_type <> 'OTHER' THEN
        RAISE EXCEPTION 'Hạng mục cọc phải có type OTHER' USING ERRCODE = '22023';
      END IF;
      IF v_service_id IS NOT NULL THEN
        PERFORM 1 FROM public.services service_row
        WHERE service_row.id = v_service_id AND service_row.organization_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Dịch vụ trong hóa đơn không thuộc tổ chức' USING ERRCODE = '42501';
        END IF;
      END IF;

      v_amount := round(v_unit * v_qty, 2);
      v_subtotal := v_subtotal + v_amount;
      IF v_class = 'DEPOSIT' THEN
        v_deposit_invoice_total := v_deposit_invoice_total + v_amount;
        v_deposit_item_count := v_deposit_item_count + 1;
      ELSE
        v_revenue_subtotal := v_revenue_subtotal + v_amount;
      END IF;
    END LOOP;

    IF v_debt_mode = 'FIRST_INVOICE' THEN
      IF v_deposit_item_count <> 1
         OR abs(v_deposit_invoice_total - v_deposit_shortfall) >= 0.01 THEN
        RAISE EXCEPTION 'Dòng cọc hóa đơn đầu phải đúng bằng phần cọc còn thiếu'
          USING ERRCODE = '22023';
      END IF;
    ELSIF v_deposit_item_count <> 0 THEN
      RAISE EXCEPTION 'Chỉ mode FIRST_INVOICE mới được có dòng cọc'
        USING ERRCODE = '22023';
    END IF;

    v_discount := COALESCE((v_first_invoice->>'discount_amount')::numeric, 0);
    IF v_discount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_discount < 0 OR v_discount > v_revenue_subtotal THEN
      RAISE EXCEPTION 'Giảm trừ không được vượt phần doanh thu không-cọc'
        USING ERRCODE = '22023';
    END IF;

    v_revenue_after_discount := GREATEST(v_revenue_subtotal - v_discount, 0);
    v_remainder := mod(v_revenue_after_discount, 1000);
    v_rounded_revenue := CASE
      WHEN v_revenue_after_discount <= 0 THEN 0
      WHEN v_remainder >= 900 THEN ceil(v_revenue_after_discount / 1000) * 1000
      ELSE floor(v_revenue_after_discount / 1000) * 1000
    END;
    v_total_amount := v_deposit_invoice_total + v_rounded_revenue;

    v_billing_month := public.compute_first_billing_month_v2(v_start_billing, v_end_billing);
    v_due_date := COALESCE(NULLIF(v_first_invoice->>'due_date', '')::date, v_end_billing);
    v_issue_date := COALESCE(NULLIF(v_first_invoice->>'issue_date', '')::date, v_signed_date);
    IF v_due_date < v_start_billing OR v_due_date > v_end_billing THEN
      RAISE EXCEPTION 'Hạn trả hóa đơn đầu phải nằm trong kỳ tính tiền đầu'
        USING ERRCODE = '22023';
    END IF;
    IF v_issue_date < v_signed_date OR v_issue_date > v_due_date THEN
      RAISE EXCEPTION 'Ngày phát hành hóa đơn đầu phải từ ngày ký đến hạn trả'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.invoices (
      user_id, organization_id, contract_id, building_id, room_id,
      invoice_number, billing_month, issue_date, due_date, status,
      subtotal, discount_amount, discount_notes, total_amount,
      prepaid_amount, paid_amount, previous_debt, notes, template_id,
      approved_at, approved_by, kind
    ) VALUES (
      v_owner, v_org, v_contract_id, v_building_id, v_room_id,
      NULL, v_billing_month, v_issue_date, v_due_date, 'APPROVED',
      v_subtotal, v_discount, NULLIF(v_first_invoice->>'discount_notes', ''),
      v_total_amount, 0, 0, 0, NULLIF(v_first_invoice->>'notes', ''),
      v_invoice_template_id,
      clock_timestamp(), v_actor, 'MONTHLY'
    ) RETURNING id INTO v_invoice_id;

    v_idx := 0;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_first_invoice->'items') LOOP
      v_unit := (v_item->>'unit_price')::numeric;
      v_qty := (v_item->>'quantity')::numeric;
      v_class := COALESCE(NULLIF(v_item->>'accounting_class', ''), 'REVENUE');
      INSERT INTO public.invoice_items (
        organization_id, invoice_id, service_id, type, description,
        unit_price, quantity, coefficient, amount, previous_reading,
        current_reading, from_date, to_date, sort_order, accounting_class
      ) VALUES (
        v_org, v_invoice_id, NULLIF(v_item->>'service_id', '')::uuid,
        COALESCE(NULLIF(v_item->>'type', ''), 'OTHER')::public.invoice_item_type,
        COALESCE(NULLIF(v_item->>'description', ''), 'Hạng mục'),
        v_unit, v_qty, 1, round(v_unit * v_qty, 2), NULL, NULL,
        CASE WHEN v_class = 'REVENUE'
          THEN COALESCE(NULLIF(v_item->>'from_date', '')::date, v_start_billing)
          ELSE NULLIF(v_item->>'from_date', '')::date
        END,
        CASE WHEN v_class = 'REVENUE'
          THEN COALESCE(NULLIF(v_item->>'to_date', '')::date, v_end_billing)
          ELSE NULLIF(v_item->>'to_date', '')::date
        END,
        v_idx,
        v_class
      );
      v_idx := v_idx + 1;
    END LOOP;

    SELECT to_jsonb(invoice_row) INTO v_invoice_row
    FROM public.invoices invoice_row WHERE invoice_row.id = v_invoice_id;
  END IF;

  PERFORM app_private.claim_feature_operation_v1(
    'contract.create.v2',
    v_org,
    v_room_id::text || '|' || v_start_date::text,
    v_actor,
    v_key,
    round(v_new_deposit_receipts + COALESCE(v_total_amount, 0), 2)
  );

  UPDATE public.room_reservation_holds
     SET status = 'APPROVED', contract_id = v_contract_id
   WHERE room_id = v_room_id
     AND held_by = v_actor
     AND status = 'PENDING_APPROVAL'
     AND expires_at > clock_timestamp();

  UPDATE public.rooms SET status = 'OCCUPIED' WHERE id = v_room_id;

  SELECT to_jsonb(contract_row) INTO v_contract_row
  FROM public.contracts contract_row WHERE contract_row.id = v_contract_id;

  v_response := jsonb_build_object(
    'contract', v_contract_row,
    'invoice', v_invoice_row,
    'deposit_paid', v_deposit_paid,
    'deposit_shortfall', v_deposit_shortfall
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.create.v2'
     AND subject_scope = v_room_id::text || '|' || v_start_date::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.create_contract_v2(jsonb, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_contract_v2(jsonb, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
