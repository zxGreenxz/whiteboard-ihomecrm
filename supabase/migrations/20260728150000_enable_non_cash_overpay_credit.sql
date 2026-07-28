-- Enable customer credit for overpayments received by TT/TK while preserving
-- cash-only refund semantics. User-approved on 2026-07-28.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
DECLARE
  v_credit_mode text;
  v_incomplete bigint;
  v_open bigint;
  v_bad_reversals bigint;
BEGIN
  SELECT mode INTO v_credit_mode
  FROM app_private.server_feature_flags
  WHERE feature_key = 'customer.credit.apply.v1'
  FOR UPDATE;

  IF v_credit_mode IS NULL OR v_credit_mode NOT IN ('SHADOW', 'ON') THEN
    RAISE EXCEPTION 'Credit activation requires SHADOW/ON, got %', v_credit_mode
      USING ERRCODE = '55000';
  END IF;

  IF app_private.evaluate_feature_route(
       'invoice.collection.v5',
       'aaaa0000-0000-4000-8000-000000000001'::uuid
     ) <> 'CANONICAL' THEN
    RAISE EXCEPTION 'invoice.collection.v5 must be CANONICAL before credit activation'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_incomplete
  FROM app_private.canonical_write_operations
  WHERE completed_at IS NULL;
  IF v_incomplete <> 0 THEN
    RAISE EXCEPTION 'Credit activation blocked by % incomplete operation(s)', v_incomplete
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_open
  FROM public.accounting_integrity_exceptions
  WHERE status = 'OPEN';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'Credit activation blocked by % open integrity exception(s)', v_open
      USING ERRCODE = '55000';
  END IF;

  SELECT app_private.count_invalid_payment_reversals_v1()
    INTO v_bad_reversals;
  IF v_bad_reversals <> 0 THEN
    RAISE EXCEPTION 'Credit activation blocked by % invalid reversal(s)', v_bad_reversals
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

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
  v_later_gross_total numeric;
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
    IF v_change_total > 0
       AND (v_last_tm_idx < 0 OR v_tm_total < v_change_total) THEN
      RAISE EXCEPTION 'Phần hoàn tiền phải nằm trong dòng tiền mặt TM của lần thu hiện tại'
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

    IF v_method = 'TM' AND v_change_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_tm_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx
        AND later.value->>'payment_method' = 'TM';

      v_line_change := LEAST(
        v_gross,
        GREATEST(v_change_total - v_later_tm_total, 0)
      );
      v_change_left := v_change_left - v_line_change;
    END IF;

    IF v_credit_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_gross_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx;

      v_line_credit := LEAST(
        v_gross - v_line_change,
        GREATEST(v_credit_total - v_later_gross_total, 0)
      );
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

COMMENT ON FUNCTION public.record_invoice_collection_v5(
  uuid, date, jsonb, text, boolean, text, text, numeric, text
) IS
  'Canonical multi-tender collection. REFUND is TM-only; CREDIT may retain overpay from TM/TK/TT.';

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

  IF round(p_applied_credit, 2) > GREATEST(
       round(
         COALESCE(p_subtotal, 0)
         + COALESCE(p_previous_debt, 0)
         - COALESCE(p_non_credit_discount_amount, 0),
         2
       ),
       0
     ) THEN
    RAISE EXCEPTION
      'Applied credit exceeds invoice amount after non-credit discounts'
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

UPDATE app_private.server_feature_flags
SET mode = 'ON',
    force_freeze = false,
    config_version = CASE WHEN mode = 'ON' THEN config_version ELSE config_version + 1 END,
    starts_at = NULL,
    ends_at = NULL,
    max_operation_count = 0,
    max_single_amount_vnd = 0,
    max_total_amount_vnd = 0,
    commit_sha = '368cafefaac6b44b12c2cda71dfc17844f1e51d9',
    migration_sha256 = '8273c0c697969128c7aa7270ef275a4a75be656fe0b792b3f2509695aec9005f',
    maintenance_window_id = 'non-cash-overpay-credit-20260728',
    approval_reference = 'user-approved-non-cash-overpay-credit-20260728',
    reason = 'Cho TT/TK thu dư thành credit bắt buộc và tự cấn các kỳ sau',
    updated_at = clock_timestamp()
WHERE feature_key = 'customer.credit.apply.v1';

DELETE FROM app_private.server_feature_flag_canary_orgs
WHERE feature_key = 'customer.credit.apply.v1';

DO $postflight$
BEGIN
  IF app_private.evaluate_feature_route(
       'customer.credit.apply.v1',
       'dddd0000-0000-4000-8000-000000000001'::uuid
     ) <> 'CANONICAL'
     OR app_private.evaluate_feature_route(
       'customer.credit.apply.v1',
       'aaaa0000-0000-4000-8000-000000000001'::uuid
     ) <> 'CANONICAL' THEN
    RAISE EXCEPTION 'customer.credit.apply.v1 did not become CANONICAL'
      USING ERRCODE = '55000';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'record_invoice_collection_v5 ACL drift after replacement'
      USING ERRCODE = '55000';
  END IF;
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';
